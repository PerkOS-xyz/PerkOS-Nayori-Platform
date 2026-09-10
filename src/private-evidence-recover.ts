import type { createEvidenceBackupLedger } from "./private-evidence-backup-ledger.js";
import type { createS3EvidenceBackup } from "./private-evidence-backup-s3.js";

/** Operator-only orchestration. The ledger intent already exists and remains discoverable
 * across failures. Never compensate an ambiguous S3/SQL response with blind deletion.
 * Retrying loads authoritative metadata and reuses the tagged S3 version.
 */
export async function recoverPrivateEvidence(id: string,
  ledger: Pick<ReturnType<typeof createEvidenceBackupLedger>, "loadRecovery" | "commitRestore">,
  objects: Pick<ReturnType<typeof createS3EvidenceBackup>, "restore">) {
  const { manifest, expected } = await ledger.loadRecovery(id);
  const recovered = await objects.restore(manifest, expected);
  await ledger.commitRestore(id, recovered.versionId, recovered.bytes);
  return { evidenceId: id, versionId: recovered.versionId, expiresAt: expected.expiresAt };
}
