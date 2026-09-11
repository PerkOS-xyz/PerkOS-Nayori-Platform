import { createRemoteJWKSet } from "jose";
import { Pool } from "pg";
import { z } from "zod";
import { createPrivateEvidenceChain } from "./private-evidence-chain.js";
import { createDirectEvidenceHttp } from "./private-evidence-direct-http.js";
import { PostgresDirectEvidenceMetadata } from "./private-evidence-direct-store.js";
import { createDirectEvidenceService } from "./private-evidence-direct.js";
import { createS3EvidenceObjects } from "./private-evidence-s3.js";
import { loadEvidenceCredentials } from "./private-evidence-credentials.js";
import { EVIDENCE_RETENTION_SECONDS } from "./private-evidence-policy.js";

const schema = z.object({
  network: z.literal("testnet"), issuer: z.literal("https://oauth.qa.nayori.ai"), audience: z.literal("https://api.qa.nayori.ai"),
  databaseUrl: z.string().refine(v => { try { return ["postgres:", "postgresql:"].includes(new URL(v).protocol); } catch { return false; } }),
  chainOrigin: z.literal("https://api.testnet.hiro.so"), contracts: z.array(z.string()).min(1).max(10),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), region: z.literal("us-east-1"),
  accountId: z.string().regex(/^\d{12}$/), credentialsFile: z.string().min(1),
});
export function loadDirectEvidenceConfig(env: NodeJS.ProcessEnv) {
  if (env.S3_EVIDENCE_QA_ENABLED === undefined || env.S3_EVIDENCE_QA_ENABLED === "false") return null;
  if (env.S3_EVIDENCE_QA_ENABLED !== "true") throw Error("invalid_s3_evidence_config");
  try {
    return schema.parse({ network: env.STACKS_NETWORK, issuer: env.OAUTH_ISSUER_ORIGIN, audience: env.OAUTH_RESOURCE_ORIGIN,
      databaseUrl: env.DATABASE_URL, chainOrigin: env.STACKS_API_URL,
      contracts: env.S3_EVIDENCE_CONTRACTS?.split(","), bucket: env.S3_EVIDENCE_BUCKET,
      region: env.S3_EVIDENCE_REGION, accountId: env.S3_EVIDENCE_ACCOUNT_ID, credentialsFile: env.S3_EVIDENCE_CREDENTIALS_FILE });
  } catch { throw Error("invalid_s3_evidence_config"); }
}

/** Optional QA-only assembly. Disabled by default; no implicit AWS credentials or production fallback. */
export async function createDirectEvidenceRuntime(input: z.infer<typeof schema>) {
  const c = schema.parse(input);
  const readJob = createPrivateEvidenceChain({ network: c.network, origin: c.chainOrigin, allowedContracts: c.contracts });
  const credentials = await loadEvidenceCredentials(c.credentialsFile);
  const objects = createS3EvidenceObjects({ bucket: c.bucket, region: c.region, accountId: c.accountId, credentials });
  const pool = new Pool({ connectionString: c.databaseUrl, max: 8, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 10000 });
  const service = createDirectEvidenceService({ metadata: new PostgresDirectEvidenceMetadata(pool), objects,
    retentionSeconds: EVIDENCE_RETENTION_SECONDS });
  const app = createDirectEvidenceHttp({ network: c.network, allowedContracts: c.contracts,
    issuer: c.issuer, audience: c.audience, keys: createRemoteJWKSet(new URL("/oauth/jwks.json", c.issuer), { timeoutDuration: 5000 }),
    readJob, service, isMerchantActive: async merchantId => {
      const result = await pool.query("SELECT 1 FROM merchants WHERE merchant_id=$1 AND status='active'", [merchantId]);
      return result.rowCount === 1;
    } });
  return { app, close: () => pool.end() };
}
