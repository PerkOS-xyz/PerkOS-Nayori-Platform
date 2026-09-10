import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evidenceBackupPhase, validateEvidenceBackupManifest, verifyEvidenceRecovery } from "../src/private-evidence-backup-policy.js";
const id = "11111111-1111-4111-8111-111111111111", bytes = Buffer.from("fixture");
const m = { schemaVersion: 1, network: "testnet", sourceKey: `private-evidence/testnet/${id}`,
  sourceVersion: "original-version", backupKey: `private-evidence-backup/testnet/${id}`, backupVersion: "backup-version",
  sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, mediaType: "text/plain",
  capturedAt: 1000, expiresAt: 2000, deleteAt: 2000 + 7 * 86400000 };
describe("QA independent backup policy", () => {
  it("preserves absolute expiry and metadata", () => {
    expect(verifyEvidenceRecovery(m, bytes, m, 1001)).toEqual(m);
  });
  it.each([[1999, "restorable"], [2000, "retained-only"], [m.deleteAt - 1, "retained-only"],
    [m.deleteAt, "purge-due"]])("enforces exact deadline %s", (now, phase) => {
    expect(evidenceBackupPhase(m, Number(now))).toBe(phase);
  });
  it.each([NaN, Infinity, 999, 1000.5])("rejects invalid/backward clock %s", now => {
    expect(() => evidenceBackupPhase(m, now)).toThrow();
  });
  it.each([{ network: "mainnet" }, { sourceKey: "private-evidence/testnet/" }, { sourceVersion: "null" },
    { backupVersion: "" }, { backupVersion: "a\nb" }, { backupKey: m.backupKey.replace(id, "22222222-2222-4222-8222-222222222222") },
    { sizeBytes: 8193 }, { sha256: "bad" }, { mediaType: "text/html" }, { secret: "unexpected" },
    { deleteAt: m.deleteAt + 1 }, { capturedAt: m.expiresAt }, { capturedAt: -1 },
    { expiresAt: 1000 + 31 * 86400000, deleteAt: 1000 + 38 * 86400000 }])("rejects invalid manifest %#", change => {
    expect(() => validateEvidenceBackupManifest({ ...m, ...change })).toThrow();
  });
  it.each(["sourceKey", "sourceVersion", "sha256", "sizeBytes", "mediaType", "expiresAt"] as const)("binds trusted metadata %s", field => {
    expect(() => verifyEvidenceRecovery(m, bytes, { ...m, [field]: "different" } as typeof m, 1001)).toThrow();
  });
  it("rejects tampered bytes and expired recovery", () => {
    expect(() => verifyEvidenceRecovery(m, Buffer.from("tamper!"), m, 1001)).toThrow();
    expect(() => verifyEvidenceRecovery(m, bytes, m, 2000)).toThrow();
    expect(() => verifyEvidenceRecovery(m, bytes, m, m.deleteAt)).toThrow();
  });
});
