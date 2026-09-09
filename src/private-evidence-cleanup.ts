import type { Pool } from "pg";
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { EVIDENCE_BACKUP_GRACE_SECONDS } from "./private-evidence-policy.js";

export interface EvidenceVersionCleanup {
  /** Must delete every exact version/marker under this key and verify absence, or throw. */
  removeExactKey(key: string): Promise<number>;
}
const safeKey = (key: string) => /^private-evidence\/testnet\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key);

/** Separate operator identity. Never give list/delete permissions to the HTTP service/agents. */
export function createS3EvidenceCleanup(options: { bucket: string; region: string; accountId: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } }): EvidenceVersionCleanup {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) || options.region !== "us-east-1" || !/^\d{12}$/.test(options.accountId)) throw Error("invalid_evidence_cleanup_config");
  const client = new S3Client({ region: options.region, credentials: { ...options.credentials }, maxAttempts: 2,
    endpoint: `https://s3.${options.region}.amazonaws.com`, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } });
  const list = (key: string) => client.send(new ListObjectVersionsCommand({ Bucket: options.bucket, Prefix: key,
    MaxKeys: 1000, ExpectedBucketOwner: options.accountId }), { abortSignal: AbortSignal.timeout(5000) });
  return { async removeExactKey(key) {
    if (!safeKey(key)) throw Error("invalid_evidence_cleanup_key");
    const result = await list(key);
    // Fail closed on replay floods rather than partially deleting an unbounded set.
    if (result.IsTruncated) throw Error("evidence_cleanup_version_limit");
    const versions = [...result.Versions ?? [], ...result.DeleteMarkers ?? []];
    if (versions.some(v => v.Key !== key || !v.VersionId || v.VersionId === "null")) throw Error("invalid_evidence_cleanup_listing");
    if (versions.length > 100) throw Error("evidence_cleanup_version_limit");
    for (const version of versions) await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key,
      VersionId: version.VersionId, ExpectedBucketOwner: options.accountId }), { abortSignal: AbortSignal.timeout(5000) });
    const after = await list(key);
    if (after.IsTruncated || after.Versions?.length || after.DeleteMarkers?.length) throw Error("evidence_cleanup_incomplete");
    return versions.length;
  } };
}

/** QA-only, bounded, explicit operator operation. No cron/HTTP/MCP registration. Default dry run.
 * Hold row lock so complete cannot race cleanup. Delete S3 BEFORE marking the row purged.
 * Partial S3 failure rolls back SQL; retry safely lists remaining exact versions.
 */
export function createEvidenceRetentionCleanup(pool: Pool, objects: EvidenceVersionCleanup, contracts: readonly string[]) {
  if (!contracts.length || contracts.some(c => !/^ST[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(c))) throw Error("invalid_evidence_cleanup_contracts");
  return async (limit: number, execute = false) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error("invalid_evidence_cleanup_limit");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(`SELECT id, object_key FROM private_evidence_objects
        WHERE network='testnet' AND contract=ANY($1::text[]) AND purged_at IS NULL
        AND (expires_at <= now() OR (version_id IS NULL AND upload_expires_at < now()-interval '60 seconds'))
        ORDER BY expires_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`, [contracts, limit]);
      let deletedVersions = 0;
      for (const row of result.rows) {
        if (!safeKey(row.object_key)) throw Error("invalid_evidence_cleanup_key");
        if (execute) {
          deletedVersions += await objects.removeExactKey(row.object_key);
          await db.query("UPDATE private_evidence_objects SET purged_at=now() WHERE id=$1", [row.id]);
        }
      }
      let pruned = 0;
      if (execute) {
        const gone = await db.query(`DELETE FROM private_evidence_objects WHERE id IN
          (SELECT id FROM private_evidence_objects WHERE network='testnet' AND contract=ANY($1::text[])
          AND purged_at IS NOT NULL AND expires_at + ($2::int * interval '1 second') <= now()
          ORDER BY expires_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)`, [contracts, EVIDENCE_BACKUP_GRACE_SECONDS, limit]);
        pruned = gone.rowCount ?? 0;
      }
      await db.query("COMMIT");
      return { dryRun: !execute, eligible: result.rowCount ?? 0, deletedVersions, pruned };
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  };
}
