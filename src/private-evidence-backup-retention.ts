import type { Pool } from "pg";
import { validateEvidenceBackupManifest } from "./private-evidence-backup-policy.js";
import { EVIDENCE_BACKUP_GRACE_SECONDS } from "./private-evidence-policy.js";

/** Operator-only, bounded, dry-run by default. Includes pending intents whose PUT may have
 * succeeded without SQL verification. No source row is needed: contract scope is persisted.
 * S3 purge must verify every exact version against the expected metadata, then verify absence.
 * Only afterward may the ledger row be removed. Partial failure leaves the row retryable.
 */
export function createBackupRetention(pool: Pool, contracts: readonly string[], objects: {
  purge(input: unknown): Promise<number>;
}) {
  if (!contracts.length || contracts.some(c => !/^ST[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(c))) throw Error("invalid_backup_contracts");
  return async (limit: number, execute = false) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error("invalid_backup_retention_limit");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(`SELECT * FROM private_evidence_backups
        WHERE contract=ANY($1::text[]) AND jsonb_typeof(expected->'expiresAt')='number'
        AND (expected->>'expiresAt')::numeric + $2 <= extract(epoch FROM clock_timestamp())*1000
        ORDER BY created_at,evidence_id LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [contracts, EVIDENCE_BACKUP_GRACE_SECONDS * 1000, limit]);
      let removedVersions = 0;
      for (const row of result.rows) {
        const e = row.expected;
        // A pending intent has no real backupVersion. This descriptor is used only to enumerate
        // and validate all versions of its deterministic key, never to read/restore "pending".
        const descriptor = validateEvidenceBackupManifest({ ...e, schemaVersion: 1, network: "testnet",
          backupKey: typeof e.sourceKey === "string" ? e.sourceKey.replace("private-evidence/", "private-evidence-backup/") : null,
          backupVersion: "pending", capturedAt: e.expiresAt - 1,
          deleteAt: e.expiresAt + EVIDENCE_BACKUP_GRACE_SECONDS * 1000 });
        if (row.manifest) {
          const m = validateEvidenceBackupManifest(row.manifest);
          for (const field of ["sourceKey", "sourceVersion", "sha256", "sizeBytes", "mediaType", "expiresAt", "backupKey", "deleteAt"] as const)
            if (m[field] !== descriptor[field]) throw Error("backup_retention_snapshot_mismatch");
        }
        if (execute) {
          removedVersions += await objects.purge(descriptor);
          await db.query("DELETE FROM private_evidence_backups WHERE evidence_id=$1", [row.evidence_id]);
        }
      }
      await db.query("COMMIT");
      return { dryRun: !execute, eligible: result.rows.length, removedVersions, removedIntents: execute ? result.rows.length : 0 };
    } catch (e) { await db.query("ROLLBACK"); throw e; }
    finally { db.release(); }
  };
}
