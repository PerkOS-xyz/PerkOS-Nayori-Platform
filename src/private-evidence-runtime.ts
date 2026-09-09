import { createRemoteJWKSet } from "jose";
import { Pool } from "pg";
import { createPrivateEvidenceChain } from "./private-evidence-chain.js";
import { createPrivateEvidenceHttp } from "./private-evidence-http.js";
import { PostgresPrivateEvidenceStore, type EvidenceKeyring, type EvidenceStorageLimits } from "./private-evidence-store.js";

/** Explicit assembly only: server.ts does not instantiate this until all privacy gates pass.
 * Dedicated bounded pool, existing Platform merchant table, no shared OAuth DB or private signing key.
 * Encryption keyring and retention/capacity policy must be supplied by the operator, never a request.
 */
export function createPrivateEvidenceRuntime(options: {
  databaseUrl: string; issuer: string; audience: string; network: "testnet" | "mainnet";
  chainOrigin: string; allowedContracts: readonly string[]; keyring: EvidenceKeyring; limits: EvidenceStorageLimits;
}) {
  const issuer = new URL(options.issuer), audience = new URL(options.audience);
  if (issuer.protocol !== "https:" || issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password ||
      audience.protocol !== "https:" || audience.username || audience.password || audience.search || audience.hash || audience.pathname !== "/" ||
      !["postgres:", "postgresql:"].includes(new URL(options.databaseUrl).protocol)) throw Error("invalid_private_evidence_runtime");
  const readJob = createPrivateEvidenceChain({ network: options.network, origin: options.chainOrigin, allowedContracts: options.allowedContracts });
  const pool = new Pool({ connectionString: options.databaseUrl, max: 8, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, idleTimeoutMillis: 10000 });
  // No SQL on construction. get/put connect only after request authentication and job authorization.
  const store = new PostgresPrivateEvidenceStore(pool, options.keyring, options.limits);
  const app = createPrivateEvidenceHttp({ network: options.network, allowedContracts: options.allowedContracts,
    issuer: options.issuer, audience: options.audience, keys: createRemoteJWKSet(new URL("/oauth/jwks.json", issuer), { timeoutDuration: 5000 }),
    readJob, store, isMerchantActive: async merchantId => {
      const result = await pool.query("SELECT 1 FROM merchants WHERE merchant_id=$1 AND status='active'", [merchantId]);
      return result.rowCount === 1;
    } });
  return { app, close: () => pool.end() };
}
