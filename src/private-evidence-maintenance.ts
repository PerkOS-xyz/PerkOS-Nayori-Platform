import type { Pool, PoolClient } from "pg";
import { openEvidence, sealEvidence, validateEvidenceContext } from "./private-evidence-security.js";
import type { EvidenceKeyring } from "./private-evidence-store.js";

/** Operator-only, not mounted in HTTP/MCP. Explicit scope and bounded batches; no key destruction.
 * Must use a bounded pool. All writes share the storage capacity lock; deletion does not erase backups.
 */
export class PrivateEvidenceMaintenance {
  private readonly contracts: string[];
  constructor(private readonly pool: Pool, private readonly keys: EvidenceKeyring,
    private readonly network: "testnet" | "mainnet", contracts: readonly string[], private readonly maxStoredBytes: number) {
    if (!["testnet","mainnet"].includes(network) || contracts.length < 1 || contracts.length > 20 ||
        !Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 1 || maxStoredBytes > 1073741824) throw Error("private_evidence_maintenance_invalid");
    this.contracts = [...new Set(contracts)];
    for (const contract of this.contracts) {
      validateEvidenceContext({ network, contract, provider: contract.split(".")[0], jobId:"1",sha256:"0".repeat(64),mediaType:"text/plain",sizeBytes:1 });
    }
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '3000ms'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",["nayori-private-evidence-capacity-v1"]);
      const result = await work(client); await client.query("COMMIT"); return result;
    } catch { await client.query("ROLLBACK").catch(()=>undefined); throw Error("private_evidence_maintenance_failed"); }
    finally { client.release(); }
  }
  async purgeExpired(limit: number, execute = false): Promise<{ count: number; executed: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || typeof execute !== "boolean") throw Error("private_evidence_maintenance_invalid");
    return this.transaction(async client => {
      const selected = await client.query(`SELECT network,contract,job_id,provider,sha256 FROM private_evidence
        WHERE network=$1 AND contract=ANY($2::text[]) AND expires_at <= clock_timestamp()
        ORDER BY expires_at,contract,job_id,provider,sha256 LIMIT $3 FOR UPDATE`,[this.network,this.contracts,limit]);
      if (execute) for (const row of selected.rows) await client.query(`DELETE FROM private_evidence
        WHERE network=$1 AND contract=$2 AND job_id=$3 AND provider=$4 AND sha256=$5 AND expires_at <= clock_timestamp()`,
        [row.network,row.contract,row.job_id,row.provider,row.sha256]);
      return {count:selected.rowCount ?? 0,executed:execute};
    });
  }
  async rotateBatch(limit: number): Promise<{ rotated: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("private_evidence_maintenance_invalid");
    // Resolve keyring before taking SQL locks. Loader is an immutable per-process snapshot.
    const active = await this.keys.active();
    return this.transaction(async client => {
      const selected = await client.query(`SELECT * FROM private_evidence WHERE network=$1 AND contract=ANY($2::text[])
        AND envelope->>'keyId' <> $3 ORDER BY contract,job_id,provider,sha256 LIMIT $4 FOR UPDATE`,[this.network,this.contracts,active.keyId,limit]);
      let delta=0;
      for (const row of selected.rows) {
        const context=validateEvidenceContext({network:row.network,contract:row.contract,jobId:row.job_id,provider:row.provider,
          sha256:row.sha256,mediaType:row.media_type,sizeBytes:row.size_bytes});
        const plaintext=openEvidence(row.envelope,context,row.envelope.keyId,await this.keys.read(row.envelope.keyId));
        let serialized: string;
        try { serialized=JSON.stringify(sealEvidence(plaintext,context,active.keyId,active.key)); } finally { plaintext.fill(0); }
        const size=Buffer.byteLength(serialized); delta+=size-row.stored_bytes;
        await client.query(`UPDATE private_evidence SET envelope=$6, stored_bytes=$7
          WHERE network=$1 AND contract=$2 AND job_id=$3 AND provider=$4 AND sha256=$5`,
          [row.network,row.contract,row.job_id,row.provider,row.sha256,serialized,size]);
      }
      if(delta>0){
        const usage=await client.query("SELECT coalesce(sum(stored_bytes),0)::text AS bytes FROM private_evidence");
        if(BigInt(usage.rows[0].bytes)>BigInt(this.maxStoredBytes)) throw Error();
      }
      return {rotated:selected.rowCount ?? 0};
    });
  }
}
