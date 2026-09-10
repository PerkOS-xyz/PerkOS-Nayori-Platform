import { isAbsolute } from "node:path";
import { loadDirectEvidenceConfig } from "./private-evidence-direct-runtime.js";

export function loadBackupOperatorConfig(env: NodeJS.ProcessEnv) {
  if (env.S3_BACKUP_QA_ENABLED !== "true") throw Error("backup_operator_disabled");
  const c = loadDirectEvidenceConfig(env);
  if (!c || c.contracts.some(v => !/^ST[A-Z0-9]+\.[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(v))) throw Error("invalid_backup_operator_config");
  const mode = env.S3_BACKUP_OPERATION ?? "status";
  if (mode !== "status" && mode !== "reconcile" && mode !== "retire") throw Error("invalid_backup_operation");
  const confirmation = env.CONFIRM_QA_BACKUP_WRITES ?? "no";
  if (!["yes", "no"].includes(confirmation) || (mode === "status" && confirmation === "yes")) throw Error("invalid_backup_confirmation");
  const batch = Number(env.S3_BACKUP_BATCH ?? "1");
  if (!Number.isInteger(batch) || batch < 1 || batch > 10) throw Error("invalid_backup_batch");
  const backupBucket = env.S3_BACKUP_BUCKET;
  if (c.bucket !== `perkos-nayori-qa-evidence-${c.accountId}` ||
      backupBucket !== `perkos-nayori-qa-evidence-backup-${c.accountId}`) throw Error("invalid_qa_backup_buckets");
  const backupFile = mode === "retire" ? env.S3_BACKUP_CLEANUP_CREDENTIALS_FILE : env.S3_BACKUP_WRITER_CREDENTIALS_FILE;
  if (mode !== "status" && (!backupFile || !isAbsolute(backupFile) || !isAbsolute(c.credentialsFile) || backupFile === c.credentialsFile))
    throw Error("separate_backup_credentials_required");
  return { ...c, mode, batch, execute: confirmation === "yes", backupBucket, backupFile };
}
