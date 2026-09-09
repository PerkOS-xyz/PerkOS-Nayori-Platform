import type { Pool, QueryResultRow } from "pg";
import type { DirectEvidenceMetadata, DirectEvidenceRecord } from "./private-evidence-direct.js";
import type { EvidenceObject } from "./private-evidence-s3.js";
import { PrivateEvidenceDenied, validateEvidenceContext } from "./private-evidence-security.js";

function decode(row: QueryResultRow): DirectEvidenceRecord {
  const context = validateEvidenceContext({ network: row.network, contract: row.contract, jobId: row.job_id,
    provider: row.provider, sha256: row.sha256, mediaType: row.media_type, sizeBytes: row.size_bytes });
  return { id: row.id, key: row.object_key, context, uploadExpiresAt: new Date(row.upload_expires_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(), object: row.version_id ? { key: row.object_key,
      versionId: row.version_id, size: context.sizeBytes, mediaType: context.mediaType,
      checksum: Buffer.from(context.sha256, "hex").toString("base64") } : null };
}

/** Pool timeouts must be configured by the operator. Reservations count until explicitly cleaned. */
export class PostgresDirectEvidenceMetadata implements DirectEvidenceMetadata {
  constructor(private readonly pool: Pool) {}
  async reserve(r: DirectEvidenceRecord): Promise<void> {
    const c = validateEvidenceContext(r.context), db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('nayori-direct-evidence-capacity-v1'))");
      const global = (await db.query("SELECT count(*)::int AS count, coalesce(sum(size_bytes),0)::bigint AS bytes FROM private_evidence_objects WHERE purged_at IS NULL")).rows[0]!;
      const job = (await db.query("SELECT count(*)::int AS count, coalesce(sum(size_bytes),0)::bigint AS bytes FROM private_evidence_objects WHERE network=$1 AND contract=$2 AND job_id=$3 AND purged_at IS NULL", [c.network, c.contract, c.jobId])).rows[0]!;
      if (global.count >= 100000 || BigInt(global.bytes) + BigInt(c.sizeBytes) > 1073741824n ||
          job.count >= 5 || BigInt(job.bytes) + BigInt(c.sizeBytes) > 16000n) throw new PrivateEvidenceDenied();
      await db.query(`INSERT INTO private_evidence_objects
        (id,network,contract,job_id,provider,sha256,media_type,size_bytes,object_key,upload_expires_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [r.id, c.network, c.contract, c.jobId, c.provider, c.sha256, c.mediaType, c.sizeBytes, r.key,
        new Date(r.uploadExpiresAt), new Date(r.expiresAt)]);
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }
  async find(id: string): Promise<DirectEvidenceRecord | null> {
    const result = await this.pool.query("SELECT * FROM private_evidence_objects WHERE id=$1 AND purged_at IS NULL", [id]);
    return result.rows[0] ? decode(result.rows[0]) : null;
  }
  async finalize(id: string, object: EvidenceObject): Promise<DirectEvidenceRecord> {
    const result = await this.pool.query(`UPDATE private_evidence_objects SET version_id=coalesce(version_id,$2)
      WHERE id=$1 AND object_key=$3 AND sha256=$4 AND size_bytes=$5 AND media_type=$6
      AND purged_at IS NULL AND expires_at > now() AND (version_id IS NOT NULL OR upload_expires_at > now()) RETURNING *`,
    [id, object.versionId, object.key, Buffer.from(object.checksum, "base64").toString("hex"), object.size, object.mediaType]);
    if (!result.rows[0]) throw new PrivateEvidenceDenied();
    return decode(result.rows[0]);
  }
}
