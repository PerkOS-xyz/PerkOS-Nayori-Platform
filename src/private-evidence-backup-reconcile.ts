import type { Pool } from "pg";
import { createEvidenceBackupLedger } from "./private-evidence-backup-ledger.js";
import type { createS3EvidenceBackup } from "./private-evidence-backup-s3.js";

/** Operator-only, sequential batches, dry-run by default. Pool max must be >=2: a dedicated
 * session holds the advisory lock while the ledger performs its own short transactions.
 * No S3 write precedes durable reserve; failed/ambiguous copies remain discoverable.
 */
export function createPendingBackupReconciliation(pool: Pool, contracts: readonly string[],
  objects: Pick<ReturnType<typeof createS3EvidenceBackup>, "copy" | "readBackup">) {
  const ledger = createEvidenceBackupLedger(pool, contracts);
  return async (limit: number, execute = false) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw Error("invalid_backup_batch_limit");
    const db = await pool.connect(); let locked = false;
    let broken = false;
    const lockKey = "hashtext(current_schema() || ':nayori-backup-reconcile-v1')";
    try {
      locked = (await db.query(`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`)).rows[0].acquired === true;
      if (!locked) return { dryRun: !execute, busy: true, eligible: 0, verified: 0, failed: 0 };
      const candidates = await db.query(`SELECT o.id FROM private_evidence_objects o
        LEFT JOIN private_evidence_backups b ON b.evidence_id=o.id
        WHERE o.network='testnet' AND o.contract=ANY($1::text[])
          AND o.purged_at IS NULL AND o.version_id IS NOT NULL AND o.expires_at>clock_timestamp()
          AND (b.evidence_id IS NULL OR (b.state='pending' AND b.contract=o.contract))
        ORDER BY coalesce(b.updated_at,o.created_at),o.id LIMIT $2`, [contracts, limit]);
      let verified = 0, failed = 0;
      if (execute) for (const row of candidates.rows) {
        try {
          const expected = await ledger.reserve(row.id);
          const manifest = await objects.copy(expected);
          const bytes = await objects.readBackup(manifest);
          await ledger.verify(row.id, manifest, bytes);
          verified++;
        } catch {
          // Counts only: do not log raw exceptions, object metadata, signed URLs or contents.
          failed++;
          // Move a failed intent behind older pending work, without changing expiry/state.
          await db.query(`UPDATE private_evidence_backups SET updated_at=clock_timestamp()
            WHERE evidence_id=$1 AND state='pending' AND contract=ANY($2::text[])`, [row.id, contracts]);
        }
      }
      return { dryRun: !execute, busy: false, eligible: candidates.rows.length, verified, failed };
    } catch (e) {
      broken = true;
      throw e;
    } finally {
      if (locked) {
        try { await db.query(`SELECT pg_advisory_unlock(${lockKey})`); }
        catch { broken = true; }
      }
      // Never return a connection with a possibly-held session lock to the pool.
      db.release(broken);
    }
  };
}
