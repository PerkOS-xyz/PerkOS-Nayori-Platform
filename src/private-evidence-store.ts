/** Internal durable storage boundary. Never expose this adapter directly over HTTP/MCP. */
import type { Pool, PoolClient } from "pg";
import {
  openEvidence, sealEvidence, validateEvidenceContext, PrivateEvidenceDenied,
  type PrivateEvidenceContext, type EncryptedEvidence,
} from "./private-evidence-security.js";

export interface EvidenceKeyring {
  /** Operator-managed key material; not stored in PostgreSQL or supplied by callers. */
  active(): Promise<{ keyId: string; key: Uint8Array }>;
  read(keyId: string): Promise<Uint8Array>;
}
export interface EvidenceStorageLimits {
  readonly maxStoredBytes: number;
  readonly maxRecords: number;
  /** No implicit retention choice: the operator must explicitly configure this. */
  readonly retentionSeconds: number;
}
type Row = {
  media_type: string; size_bytes: number; envelope: EncryptedEvidence;
  expires_at: Date; live: boolean;
};
const lock = "nayori-private-evidence-capacity-v1";
const denied = () => new PrivateEvidenceDenied();
const binding = (c: PrivateEvidenceContext) => [c.network, c.contract, c.jobId, c.provider, c.sha256];
const predicate = "network=$1 AND contract=$2 AND job_id=$3 AND provider=$4 AND sha256=$5";

/**
 * Every call requires a freshly authenticated/chain-authorized callback. It runs before
 * any existence lookup or key access, and again before returning plaintext/committing.
 * Callback must fail closed; it must NOT cache authorization or trust request JSON.
 * No plaintext is passed to SQL. Failure messages never include SQL/body/key material.
 */
export class PostgresPrivateEvidenceStore {
  private readonly limits: Readonly<EvidenceStorageLimits>;
  constructor(private readonly pool: Pool, private readonly keys: EvidenceKeyring, limits: EvidenceStorageLimits) {
    if (!Number.isSafeInteger(limits.maxStoredBytes) || limits.maxStoredBytes < 1 || limits.maxStoredBytes > 1_073_741_824 ||
        !Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1 || limits.maxRecords > 100_000 ||
        !Number.isSafeInteger(limits.retentionSeconds) || limits.retentionSeconds < 60 || limits.retentionSeconds > 31_536_000) throw denied();
    this.limits = Object.freeze({ ...limits });
  }

  async put(input: PrivateEvidenceContext, bytes: Uint8Array, authorize: () => Promise<void>): Promise<{ expiresAt: string; created: boolean }> {
    let client: PoolClient | undefined;
    try {
      const c = validateEvidenceContext(input);
      await authorize();
      if (!(bytes instanceof Uint8Array) || bytes.length !== c.sizeBytes) throw denied();
      // Capture bytes before async key retrieval to prevent mutation across awaits.
      const snapshot = Buffer.from(bytes);
      const active = await this.keys.active();
      const envelope = sealEvidence(snapshot, c, active.keyId, active.key);
      const serialized = JSON.stringify(envelope);
      const storedBytes = Buffer.byteLength(serialized);
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5000ms'");
      await client.query("SET LOCAL lock_timeout = '3000ms'");
      // One bounded global lock serializes quota checks and writes across all processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
      const existing = await client.query<Row>(`SELECT media_type,size_bytes,envelope,expires_at,
        expires_at > clock_timestamp() AS live FROM private_evidence WHERE ${predicate}`, binding(c));
      const row = existing.rows[0];
      if (row) {
        if (!row.live || row.media_type !== c.mediaType || row.size_bytes !== c.sizeBytes) throw denied();
        // Retry returns the original encrypted record/expiry; no overwrite or TTL renewal.
        openEvidence(row.envelope, c, row.envelope.keyId, await this.keys.read(row.envelope.keyId));
        await authorize();
        if (row.expires_at.getTime() <= Date.now()) throw denied();
        await client.query("COMMIT");
        return { created: false, expiresAt: row.expires_at.toISOString() };
      }
      const usage = await client.query<{ count: string; bytes: string }>(
        "SELECT count(*)::text AS count, coalesce(sum(stored_bytes),0)::text AS bytes FROM private_evidence");
      const jobUsage = await client.query<{ count: string; bytes: string }>(
        `SELECT count(*)::text AS count, coalesce(sum(size_bytes),0)::text AS bytes
         FROM private_evidence WHERE network=$1 AND contract=$2 AND job_id=$3`, binding(c).slice(0, 3));
      if (Number(usage.rows[0]!.count) >= this.limits.maxRecords ||
          Number(usage.rows[0]!.bytes) + storedBytes > this.limits.maxStoredBytes ||
          Number(jobUsage.rows[0]!.count) >= 5 || Number(jobUsage.rows[0]!.bytes) + c.sizeBytes > 16000) throw denied();
      await authorize();
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO private_evidence(network,contract,job_id,provider,sha256,media_type,size_bytes,envelope,stored_bytes,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10 * interval '1 second') RETURNING expires_at`,
        [...binding(c), c.mediaType, c.sizeBytes, serialized, storedBytes, this.limits.retentionSeconds]);
      await client.query("COMMIT");
      return { created: true, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      throw denied();
    } finally { client?.release(); }
  }

  async get(input: PrivateEvidenceContext, authorize: () => Promise<void>): Promise<Buffer> {
    try {
      const c = validateEvidenceContext(input);
      await authorize();
      const result = await this.pool.query<Row>(`SELECT media_type,size_bytes,envelope,expires_at,
        expires_at > clock_timestamp() AS live FROM private_evidence WHERE ${predicate}`, binding(c));
      const row = result.rows[0];
      if (!row?.live || row.media_type !== c.mediaType || row.size_bytes !== c.sizeBytes) throw denied();
      const key = await this.keys.read(row.envelope.keyId);
      await authorize();
      if (row.expires_at.getTime() <= Date.now()) throw denied();
      return openEvidence(row.envelope, c, row.envelope.keyId, key);
    } catch { throw denied(); }
  }
}
