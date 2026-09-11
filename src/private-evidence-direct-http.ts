import { Hono } from "hono";
import { EvidenceIssuerBusy } from "./evidence-issuer-busy.js";
import { EvidenceChainBusy } from "./evidence-chain-busy.js";
import { z } from "zod";
import type { JWTVerifyGetKey } from "jose";
import { createIssuerEvidenceIdentityCheck } from "./evidence-issuer-client.js";
import { readPrivateEvidenceJson } from "./private-evidence-http.js";
import { authenticateEvidence, authorizeEvidence, type PrivateEvidenceJob } from "./private-evidence-security.js";
import type { createDirectEvidenceService, DirectEvidenceAuthorize } from "./private-evidence-direct.js";
import { createEvidenceAdmission } from "./private-evidence-policy.js";

const prepare = z.object({ context: z.unknown() }).strict();
const file = z.object({ id: z.string().uuid() }).strict();

/** Inactive: server.ts deliberately does not mount these routes before QA deployment gates. */
export function createDirectEvidenceHttp(options: {
  network: "testnet" | "mainnet"; allowedContracts: readonly string[];
  issuer: string; audience: string; keys: JWTVerifyGetKey;
  isMerchantActive: (merchantId: string) => Promise<boolean>;
  readJob: (contract: string, jobId: string) => Promise<PrivateEvidenceJob | null>;
  service: ReturnType<typeof createDirectEvidenceService>; issuerFetcher?: typeof fetch;
}) {
  const app = new Hono(), allowedContracts = Object.freeze([...options.allowedContracts]);
  const admit = createEvidenceAdmission();
  let inflight = 0;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer"); c.header("X-Content-Type-Options", "nosniff");
    if (inflight >= 8) return c.json({ error: "private_evidence_access_denied" }, 429);
    inflight++;
    try { await next(); } finally { inflight--; }
  });
  for (const operation of ["prepare", "complete", "download"] as const) {
    app.post(`/v1/private-evidence/${operation}`, async c => {
      try {
        if (new URL(c.req.url).search || c.req.header("cookie")) throw Error("denied");
        const authorization = c.req.header("authorization");
        if (!authorization) throw Error("denied");
        const scope = operation === "download" ? "evidence:read" : "evidence:write";
        const authenticate = () => authenticateEvidence({ authorization, scope, network: options.network,
          issuer: options.issuer, audience: options.audience, keys: options.keys,
          activeIdentity: createIssuerEvidenceIdentityCheck({ issuer: options.issuer, authorization, scope,
            isMerchantActive: options.isMerchantActive, fetcher: options.issuerFetcher }) });
        const initialIdentity = await authenticate();
        if (!admit(initialIdentity.walletAddress, operation)) return c.json({ error: "private_evidence_rate_limited" }, 429);
        const body = await readPrivateEvidenceJson(c.req.raw);
        const authorize: DirectEvidenceAuthorize = async (context, requestedScope) => {
          if (scope !== requestedScope) throw Error("denied");
          await authorizeEvidence({ identity: await authenticate(), scope, context, network: options.network,
            allowedContracts, readJob: options.readJob });
        };
        if (operation === "prepare") return c.json(await options.service.prepare(prepare.parse(body).context, authorize), 201);
        const { id } = file.parse(body);
        return c.json(await options.service[operation](id, authorize));
      } catch (error) {
        void c.req.raw.body?.cancel().catch(() => undefined);
        if (error instanceof EvidenceIssuerBusy || error instanceof EvidenceChainBusy) {
          c.header("Retry-After", String(error.retryAfterSeconds));
          return c.json({ error: "private_evidence_temporarily_unavailable" }, 503);
        }
        return c.json({ error: "private_evidence_access_denied" }, 403);
      }
    });
  }
  return app;
}
