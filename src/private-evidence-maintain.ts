/** Explicit QA operator CLI. Never imported by server.ts. Counts only; no secret/content logs. */
import { Pool } from "pg";
import { loadDirectEvidenceConfig } from "./private-evidence-direct-runtime.js";
import { loadEvidenceCredentials } from "./private-evidence-credentials.js";
import { createEvidenceRetentionCleanup, createS3EvidenceCleanup } from "./private-evidence-cleanup.js";

let pool: Pool | undefined;
try {
  const c = loadDirectEvidenceConfig(process.env);
  if (!c) throw Error("cleanup_requires_explicit_qa_configuration");
  const credentials = await loadEvidenceCredentials(process.env.S3_EVIDENCE_CLEANUP_CREDENTIALS_FILE ?? "");
  const objects = createS3EvidenceCleanup({ bucket: c.bucket, region: c.region, accountId: c.accountId, credentials });
  pool = new Pool({ connectionString: c.databaseUrl, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000, idleTimeoutMillis: 10000 });
  const run = createEvidenceRetentionCleanup(pool, objects, c.contracts);
  const confirm = process.env.CONFIRM_QA_EVIDENCE_PURGE;
  if (confirm !== undefined && confirm !== "no" && confirm !== "yes") throw Error("invalid_purge_confirmation");
  const result = await run(Number(process.env.S3_EVIDENCE_CLEANUP_BATCH ?? "1"), confirm === "yes");
  console.log(JSON.stringify({ event: "qa_evidence_cleanup", ...result }));
} catch {
  console.error(JSON.stringify({ event: "qa_evidence_cleanup_failed" })); process.exitCode = 1;
} finally { await pool?.end(); }
