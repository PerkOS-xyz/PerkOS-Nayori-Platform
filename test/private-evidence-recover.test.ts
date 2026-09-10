import { expect, it, vi } from "vitest";
import { recoverPrivateEvidence } from "../src/private-evidence-recover.js";
import type { EvidenceBackupManifest } from "../src/private-evidence-backup-policy.js";
it("commits only exact-version readback and does not delete on ambiguous SQL commit", async () => {
  const manifest = { expiresAt: 1234 } as EvidenceBackupManifest;
  const ledger = { loadRecovery: vi.fn(async () => ({ manifest, expected: manifest })),
    commitRestore: vi.fn().mockRejectedValueOnce(Error("ambiguous commit")).mockResolvedValueOnce(undefined) };
  const bytes = new Uint8Array([1]);
  const objects = { restore: vi.fn(async () => ({ versionId: "same-restored-version", bytes })) };
  await expect(recoverPrivateEvidence("fixture", ledger, objects)).rejects.toThrow("ambiguous commit");
  expect(await recoverPrivateEvidence("fixture", ledger, objects)).toEqual({ evidenceId: "fixture", versionId: "same-restored-version", expiresAt: 1234 });
  expect(ledger.loadRecovery).toHaveBeenCalledTimes(2);
  expect(ledger.commitRestore).toHaveBeenNthCalledWith(2, "fixture", "same-restored-version", bytes);
});
it("does not commit when S3 verification fails", async () => {
  const manifest = {} as EvidenceBackupManifest;
  const ledger = { loadRecovery: vi.fn(async () => ({ manifest, expected: manifest })), commitRestore: vi.fn() };
  const objects = { restore: vi.fn(async () => { throw Error("invalid bytes"); }) };
  await expect(recoverPrivateEvidence("fixture", ledger, objects)).rejects.toThrow();
  expect(ledger.commitRestore).not.toHaveBeenCalled();
});
