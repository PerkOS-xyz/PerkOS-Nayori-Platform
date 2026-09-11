import { createHash } from "node:crypto";
import { z } from "zod";
import { EVIDENCE_BACKUP_GRACE_SECONDS, EVIDENCE_RETENTION_SECONDS } from "./private-evidence-policy.js";

const timestamp = z.number().int().nonnegative().max(8640000000000000);
const version = z.string().min(1).max(1024).refine(v => v !== "null" && [...v].every(c => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127));
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const schema = z.object({
  schemaVersion: z.literal(1), network: z.literal("testnet"),
  sourceKey: z.string().regex(new RegExp(`^private-evidence/testnet/${uuid}$`)),
  sourceVersion: version,
  backupKey: z.string().regex(new RegExp(`^private-evidence-backup/testnet/${uuid}$`)),
  backupVersion: version,
  sha256: z.string().regex(/^[0-9a-f]{64}$/), sizeBytes: z.number().int().min(1).max(8192),
  mediaType: z.enum(["text/plain", "application/json"]),
  capturedAt: timestamp, expiresAt: timestamp, deleteAt: timestamp,
}).strict().superRefine((m, ctx) => {
  if (m.backupKey.split("/").at(-1) !== m.sourceKey.split("/").at(-1) ||
      m.capturedAt >= m.expiresAt || m.expiresAt - m.capturedAt > EVIDENCE_RETENTION_SECONDS * 1000 ||
      m.deleteAt !== m.expiresAt + EVIDENCE_BACKUP_GRACE_SECONDS * 1000) {
    ctx.addIssue({ code: "custom", message: "invalid_backup_policy" });
  }
});
export type EvidenceBackupManifest = z.infer<typeof schema>;

/** Manifest input is untrusted. Never use it to extend access or choose an arbitrary S3 key. */
export function validateEvidenceBackupManifest(input: unknown): EvidenceBackupManifest {
  const result = schema.safeParse(input);
  if (!result.success) throw Error("invalid_evidence_backup_manifest");
  return result.data;
}

export function evidenceBackupPhase(input: unknown, now: number): "restorable" | "retained-only" | "purge-due" {
  const m = validateEvidenceBackupManifest(input);
  if (!Number.isSafeInteger(now) || now < m.capturedAt) throw Error("invalid_evidence_backup_clock");
  return now >= m.deleteAt ? "purge-due" : now >= m.expiresAt ? "retained-only" : "restorable";
}

/** Verify against trusted SQL metadata too: a self-consistent forged manifest is insufficient.
 * The caller must lock/re-read this row and check expiry again when committing a new VersionId.
 * This pure gate does not write S3, SQL or register any HTTP/MCP endpoint.
 */
export function verifyEvidenceRecovery(input: unknown, bytes: Uint8Array, expected: {
  sourceKey: string; sourceVersion: string; sha256: string; sizeBytes: number;
  mediaType: string; expiresAt: number;
}, now: number): EvidenceBackupManifest {
  const m = validateEvidenceBackupManifest(input);
  if (evidenceBackupPhase(m, now) !== "restorable" ||
      m.sourceKey !== expected.sourceKey || m.sourceVersion !== expected.sourceVersion ||
      m.sha256 !== expected.sha256 || m.sizeBytes !== expected.sizeBytes ||
      m.mediaType !== expected.mediaType || m.expiresAt !== expected.expiresAt ||
      bytes.byteLength !== m.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== m.sha256) {
    throw Error("evidence_recovery_denied");
  }
  return m;
}
