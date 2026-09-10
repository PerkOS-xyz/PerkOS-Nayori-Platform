import type { Pool, PoolClient, QueryResultRow } from "pg";
import { validateEvidenceBackupManifest, verifyEvidenceRecovery } from "./private-evidence-backup-policy.js";
import type { EvidenceBackupSource } from "./private-evidence-backup-s3.js";
import { EVIDENCE_BACKUP_GRACE_SECONDS } from "./private-evidence-policy.js";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function snapshot(row: QueryResultRow): EvidenceBackupSource {
  return { sourceKey: row.object_key, sourceVersion: row.version_id, sha256: row.sha256,
    sizeBytes: row.size_bytes, mediaType: row.media_type, expiresAt: new Date(row.expires_at).getTime() };
}
const same = (a: EvidenceBackupSource, b: EvidenceBackupSource) =>
  (["sourceKey", "sourceVersion", "sha256", "sizeBytes", "mediaType", "expiresAt"] as const).every(k => a[k] === b[k]);

/** Operator-only persistence. Caller must durably commit reserve() BEFORE any S3 write.
 * Locks source before ledger consistently. Pool must have bounded query/lock/idle timeouts.
 * Does not schedule work, restore S3 bytes or infer that an unverified copy can be deleted.
 */
export function createEvidenceBackupLedger(pool: Pool, contracts: readonly string[]) {
  if (!contracts.length || contracts.some(c => !/^ST[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(c))) throw Error("invalid_backup_contracts");
  async function transaction<T>(id: string, work: (db: PoolClient, row: QueryResultRow, time: number) => Promise<T>) {
    if (!idPattern.test(id)) throw Error("invalid_backup_id");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const r = await db.query(`SELECT * FROM private_evidence_objects WHERE id=$1 AND network='testnet'
        AND contract=ANY($2::text[]) AND purged_at IS NULL AND version_id IS NOT NULL FOR UPDATE`, [id, contracts]);
      if (!r.rows[0]) throw Error("backup_source_unavailable");
      const time = Number((await db.query("SELECT extract(epoch FROM clock_timestamp())*1000 AS ms")).rows[0].ms);
      if (new Date(r.rows[0].expires_at).getTime() <= time) throw Error("backup_source_expired");
      const result = await work(db, r.rows[0], Math.floor(time));
      await db.query("COMMIT"); return result;
    } catch (e) { await db.query("ROLLBACK"); throw e; }
    finally { db.release(); }
  }
  return {
    async reserve(id: string): Promise<EvidenceBackupSource> {
      return transaction(id, async (db, row, time) => {
        const expected = snapshot(row);
        // Reuse the strict policy validation without claiming a real backup exists yet.
        validateEvidenceBackupManifest({ ...expected, schemaVersion: 1, network: "testnet",
          backupKey: expected.sourceKey.replace("private-evidence/", "private-evidence-backup/"),
          backupVersion: "pending", capturedAt: time, deleteAt: expected.expiresAt + EVIDENCE_BACKUP_GRACE_SECONDS * 1000 });
        await db.query("INSERT INTO private_evidence_backups (evidence_id,expected) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, expected]);
        const saved = (await db.query("SELECT * FROM private_evidence_backups WHERE evidence_id=$1 FOR UPDATE", [id])).rows[0];
        if (saved.state === "purged" || !same(saved.expected, expected)) throw Error("backup_snapshot_changed");
        return expected;
      });
    },
    async verify(id: string, input: unknown, bytes: Uint8Array): Promise<void> {
      const m = validateEvidenceBackupManifest(input);
      await transaction(id, async (db, row, time) => {
        const saved = (await db.query("SELECT * FROM private_evidence_backups WHERE evidence_id=$1 FOR UPDATE", [id])).rows[0];
        if (!saved || saved.state === "purged" || !same(saved.expected, snapshot(row))) throw Error("backup_snapshot_changed");
        verifyEvidenceRecovery(m, bytes, saved.expected, time);
        if (saved.manifest && JSON.stringify(validateEvidenceBackupManifest(saved.manifest)) !== JSON.stringify(m)) throw Error("backup_manifest_changed");
        const update = await db.query(`UPDATE private_evidence_backups SET manifest=$2,state='verified',updated_at=clock_timestamp()
          WHERE evidence_id=$1 AND EXISTS (SELECT 1 FROM private_evidence_objects WHERE id=$1 AND expires_at>clock_timestamp())`, [id, m]);
        if (update.rowCount !== 1) throw Error("backup_source_expired");
      });
    },
    /** After S3 writes + exact-version readback, atomically rebind metadata, preserving expiry.
     * bytes must come from the NEW version readback. This does not itself perform that readback.
     * Do not delete an S3 version after ambiguous COMMIT; retry with the SAME version first.
     */
    async commitRestore(id: string, newVersion: string, bytes: Uint8Array): Promise<void> {
      if (!newVersion || newVersion === "null" || newVersion.length > 1024 ||
          [...newVersion].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) >= 127)) throw Error("invalid_restore_version");
      await transaction(id, async (db, row, time) => {
        const saved = (await db.query("SELECT * FROM private_evidence_backups WHERE evidence_id=$1 FOR UPDATE", [id])).rows[0];
        if (!saved || saved.state !== "verified") throw Error("backup_not_verified");
        const expected = saved.expected as EvidenceBackupSource;
        verifyEvidenceRecovery(saved.manifest, bytes, expected, time);
        if (!same({ ...snapshot(row), sourceVersion: expected.sourceVersion }, expected)) throw Error("backup_snapshot_changed");
        if (saved.restored_version === newVersion && row.version_id === newVersion) return;
        if (saved.restored_version || row.version_id !== expected.sourceVersion || newVersion === expected.sourceVersion) throw Error("restore_version_conflict");
        const update = await db.query(`UPDATE private_evidence_objects SET version_id=$2 WHERE id=$1
          AND version_id=$3 AND purged_at IS NULL AND expires_at>clock_timestamp()`, [id, newVersion, expected.sourceVersion]);
        if (update.rowCount !== 1) throw Error("restore_source_unavailable");
        await db.query("UPDATE private_evidence_backups SET restored_version=$2,updated_at=clock_timestamp() WHERE evidence_id=$1", [id, newVersion]);
      });
    },
  };
}
