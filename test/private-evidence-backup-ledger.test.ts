import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createEvidenceBackupLedger } from "../src/private-evidence-backup-ledger.js";
const id = "11111111-1111-4111-8111-111111111111", bytes = Buffer.from("fixture");
const expected = { sourceKey: `private-evidence/testnet/${id}`, sourceVersion: "old",
  sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: 7, mediaType: "text/plain", expiresAt: 10000 };
const manifest = { ...expected, schemaVersion: 1, network: "testnet", backupKey: `private-evidence-backup/testnet/${id}`,
  backupVersion: "copy", capturedAt: 1000, deleteAt: 10000 + 7 * 86400000 };
function setup(failUpdate = false) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT * FROM private_evidence_objects")) return { rows: [{ object_key: expected.sourceKey,
      version_id: "old", sha256: expected.sha256, size_bytes: 7, media_type: "text/plain", expires_at: new Date(10000) }] };
    if (sql.startsWith("SELECT extract")) return { rows: [{ ms: 2000 }] };
    if (sql.startsWith("SELECT * FROM private_evidence_backups")) return { rows: [{ expected, manifest, state: "verified", restored_version: null }] };
    if (sql.startsWith("UPDATE private_evidence_objects")) return { rowCount: failUpdate ? 0 : 1 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { query, release, pool, ledger: createEvidenceBackupLedger(pool, ["ST123.contract"]) };
}
it("rolls back if expiry crosses between precheck and final SQL update", async () => {
  const s = setup(true);
  await expect(s.ledger.commitRestore(id, "new", bytes)).rejects.toThrow("restore_source_unavailable");
  expect(s.query.mock.calls.some(([sql]) => sql.includes("expires_at>clock_timestamp()"))).toBe(true);
  expect(s.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE private_evidence_backups"))).toBe(false);
  expect(s.query).toHaveBeenCalledWith("ROLLBACK"); expect(s.release).toHaveBeenCalled();
});
it("updates source and receipt in one transaction", async () => {
  const s = setup(); await s.ledger.commitRestore(id, "new", bytes);
  expect(s.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE private_evidence_backups"))).toBe(true);
  expect(s.query).toHaveBeenCalledWith("COMMIT"); expect(s.release).toHaveBeenCalled();
});
it("rejects invalid input before connecting", async () => {
  const s = setup();
  await expect(s.ledger.reserve("bad")).rejects.toThrow();
  await expect(s.ledger.commitRestore(id, "null", bytes)).rejects.toThrow();
  expect(s.pool.connect).not.toHaveBeenCalled();
  expect(() => createEvidenceBackupLedger(s.pool, ["SP123.contract"])).toThrow();
});
