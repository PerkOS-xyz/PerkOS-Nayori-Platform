import type { Pool } from "pg";
import { validateEvidenceBackupManifest } from "./private-evidence-backup-policy.js";
import { EVIDENCE_BACKUP_GRACE_SECONDS } from "./private-evidence-policy.js";

/** Bounded operator inspection, counts only. Truncated means NOT a clean bill of health.
 * No quarantine repair, source content, object keys, wallet IDs or raw exceptions in output.
 */
export async function inspectBackupLedger(pool: Pool, contracts: readonly string[]) {
  if (!contracts.length || contracts.some(c => !/^ST[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(c))) throw Error("invalid_backup_contracts");
  const result = await pool.query(`SELECT expected,manifest,state,contract FROM private_evidence_backups
    WHERE contract=ANY($1::text[]) OR contract IS NULL ORDER BY updated_at,evidence_id LIMIT 101`, [contracts]);
  let inconsistent = 0, quarantined = 0, pending = 0, verified = 0;
  for (const row of result.rows.slice(0, 100)) {
    if (row.contract === null) quarantined++;
    if (row.state === "pending") pending++;
    if (row.state === "verified") verified++;
    try {
      const e = row.expected;
      const descriptor = validateEvidenceBackupManifest({ ...e, schemaVersion: 1, network: "testnet",
        backupKey: typeof e.sourceKey === "string" ? e.sourceKey.replace("private-evidence/", "private-evidence-backup/") : null,
        backupVersion: "pending", capturedAt: e.expiresAt - 1, deleteAt: e.expiresAt + EVIDENCE_BACKUP_GRACE_SECONDS * 1000 });
      if (row.state === "verified" && !row.manifest) throw Error();
      if (row.manifest) {
        const m = validateEvidenceBackupManifest(row.manifest);
        for (const k of ["sourceKey", "sourceVersion", "sha256", "sizeBytes", "mediaType", "expiresAt", "backupKey", "deleteAt"] as const)
          if (m[k] !== descriptor[k]) throw Error();
      }
    } catch { inconsistent++; }
  }
  return { inspected: Math.min(result.rows.length, 100), truncated: result.rows.length > 100, inconsistent, quarantined, pending, verified };
}
