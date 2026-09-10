/** Explicit one-shot QA operator. Not imported by the web server; no implicit schedule. */
import { Pool } from "pg";
import { loadBackupOperatorConfig } from "./private-evidence-backup-operator-config.js";
import { inspectBackupLedger } from "./private-evidence-backup-diagnostics.js";
import { loadEvidenceCredentials } from "./private-evidence-credentials.js";
import { createS3EvidenceBackup } from "./private-evidence-backup-s3.js";
import { createPendingBackupReconciliation } from "./private-evidence-backup-reconcile.js";
import { createBackupRetention } from "./private-evidence-backup-retention.js";

let pool: Pool | undefined;
let objects: ReturnType<typeof createS3EvidenceBackup> | undefined;
try {
  const c = loadBackupOperatorConfig(process.env);
  pool = new Pool({ connectionString: c.databaseUrl, max: 4, connectionTimeoutMillis: 5000,
    query_timeout: 10000, statement_timeout: 10000, idleTimeoutMillis: 10000 });
  const before = await inspectBackupLedger(pool, c.contracts);
  if (before.quarantined || before.inconsistent || before.truncated) {
    console.log(JSON.stringify({ event: "qa_backup_attention", ...before })); process.exitCode = 2;
  } else if (c.mode === "status") {
    console.log(JSON.stringify({ event: "qa_backup_status", ...before }));
  } else {
    const sourceCredentials = await loadEvidenceCredentials(c.credentialsFile);
    const backupCredentials = await loadEvidenceCredentials(c.backupFile!);
    if (sourceCredentials.accessKeyId === backupCredentials.accessKeyId) throw Error("backup_identity_not_separate");
    objects = createS3EvidenceBackup({ sourceBucket: c.bucket, backupBucket: c.backupBucket,
      region: c.region, accountId: c.accountId, sourceCredentials, backupCredentials });
    if (c.mode === "reconcile") {
      const result = await createPendingBackupReconciliation(pool, c.contracts, objects)(c.batch, c.execute);
      console.log(JSON.stringify({ event: "qa_backup_reconcile", ...result }));
      if (result.failed) process.exitCode = 2;
      else if (result.busy) process.exitCode = 3;
    } else {
      const result = await createBackupRetention(pool, c.contracts, objects)(c.batch, c.execute);
      console.log(JSON.stringify({ event: "qa_backup_retire", ...result }));
    }
  }
} catch {
  console.error(JSON.stringify({ event: "qa_backup_operator_failed" })); process.exitCode = 1;
} finally { objects?.close(); await pool?.end(); }
