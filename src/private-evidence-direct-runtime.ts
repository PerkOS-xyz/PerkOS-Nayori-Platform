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

export const MAINNET_PRIVATE_EVIDENCE_CONFIRMATION = "enable-private-evidence-v6-v5-mainnet";
const release = {
  qa: {
    network: "testnet", issuer: "https://oauth.qa.nayori.ai", audience: "https://api.qa.nayori.ai",
    chainOrigin: "https://api.testnet.hiro.so", accountId: "089332276762", bucketPrefix: "perkos-nayori-qa-evidence-",
    contracts: ["ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.agentic-commerce-v6",
      "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5"],
  },
  production: {
    network: "mainnet", issuer: "https://oauth.nayori.ai", audience: "https://nayori.ai",
    chainOrigin: "https://api.hiro.so", accountId: "089332276762", bucketPrefix: "perkos-nayori-prod-evidence-",
    contracts: ["SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.agentic-commerce-v6",
      "SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH.sbtc-commerce-v5"],
  },
} as const;
const schema = z.object({
  environment: z.enum(["qa", "production"]), network: z.enum(["testnet", "mainnet"]),
  issuer: z.url(), audience: z.url(),
  databaseUrl: z.string().refine(v => { try { return ["postgres:", "postgresql:"].includes(new URL(v).protocol); } catch { return false; } }),
  chainOrigin: z.url(), contracts: z.array(z.string()).length(2),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), region: z.literal("us-east-1"),
  accountId: z.string().regex(/^\d{12}$/), credentialsFile: z.string().startsWith("/"), confirmation: z.string().optional(),
}).superRefine((value, context) => {
  const selected = release[value.environment];
  const sameContracts = value.contracts.length === selected.contracts.length &&
    selected.contracts.every(contract => value.contracts.includes(contract));
  if (value.network !== selected.network || value.issuer !== selected.issuer || value.audience !== selected.audience ||
      value.chainOrigin !== selected.chainOrigin || !sameContracts ||
      value.accountId !== selected.accountId ||
      value.bucket !== `${selected.bucketPrefix}${value.accountId}` ||
      (value.environment === "production" && value.confirmation !== MAINNET_PRIVATE_EVIDENCE_CONFIRMATION)) {
    context.addIssue({ code: "custom", message: "Private evidence runtime does not match an exact release tuple." });
  }
});
export function loadDirectEvidenceConfig(env: NodeJS.ProcessEnv) {
  const legacy = env.S3_EVIDENCE_QA_ENABLED;
  const enabled = env.S3_EVIDENCE_ENABLED;
  if ((legacy === undefined || legacy === "false") && (enabled === undefined || enabled === "false")) return null;
  if ((legacy !== undefined && !["true", "false"].includes(legacy)) ||
      (enabled !== undefined && !["true", "false"].includes(enabled)) ||
      (legacy === "true" && enabled !== undefined)) throw Error("invalid_s3_evidence_config");
  const environment = legacy === "true" ? "qa" : env.S3_EVIDENCE_ENV;
  try {
    return schema.parse({ environment, network: env.STACKS_NETWORK, issuer: env.OAUTH_ISSUER_ORIGIN, audience: env.OAUTH_RESOURCE_ORIGIN,
      databaseUrl: env.DATABASE_URL, chainOrigin: env.STACKS_API_URL,
      contracts: env.S3_EVIDENCE_CONTRACTS?.split(","), bucket: env.S3_EVIDENCE_BUCKET,
      region: env.S3_EVIDENCE_REGION, accountId: env.S3_EVIDENCE_ACCOUNT_ID, credentialsFile: env.S3_EVIDENCE_CREDENTIALS_FILE,
      confirmation: env.CONFIRM_MAINNET_PRIVATE_EVIDENCE });
  } catch { throw Error("invalid_s3_evidence_config"); }
}

/** Optional exact-environment assembly. Disabled by default; no ambient AWS credentials or cross-environment fallback. */
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
