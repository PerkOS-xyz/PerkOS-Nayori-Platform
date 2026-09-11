import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { createIssuerEvidenceIdentityCheck } from "./evidence-issuer-client.js";
import { authenticateEvidence, authorizeEvidence, validateEvidenceContext, PrivateEvidenceDenied,
  type PrivateEvidenceJob, type EvidenceScope } from "./private-evidence-security.js";
import type { PostgresPrivateEvidenceStore } from "./private-evidence-store.js";

const writeSchema = z.object({ context: z.unknown(), content: z.string() }).strict();
const readSchema = z.object({ context: z.unknown() }).strict();
const deny = () => new PrivateEvidenceDenied();

/** Bound even chunked/slow request bodies; never use request.json() on untrusted streams. */
export async function readPrivateEvidenceJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type") !== "application/json" || request.headers.has("content-encoding")) throw deny();
  const reader = request.body?.getReader();
  if (!reader) throw deny();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([(async () => {
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) throw deny();
        chunks.push(part.value);
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
    })(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(deny()), 5000);
    })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

/** Inactive factory: deliberately not mounted by server.ts until activation gates pass.
 * Dependencies are operator-owned; never construct them from request JSON or LLM tools.
 * readJob/key resolver/database adapters must enforce their own bounded I/O timeouts.
 */
export function createPrivateEvidenceHttp(options: {
  network: "testnet" | "mainnet"; allowedContracts: readonly string[];
  issuer: string; audience: string; keys: JWTVerifyGetKey;
  isMerchantActive: (merchantId: string) => Promise<boolean>;
  readJob: (contract: string, jobId: string) => Promise<PrivateEvidenceJob | null>;
  store: Pick<PostgresPrivateEvidenceStore, "put" | "get">;
  issuerFetcher?: typeof fetch;
}) {
  const trusted = Object.freeze({ ...options, allowedContracts: Object.freeze([...options.allowedContracts]) });
  const app = new Hono();
  let inflight = 0;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    if (inflight >= 8) return c.json({ error: "private_evidence_access_denied" }, 429);
    inflight++;
    try { await next(); } finally { inflight--; }
  });
  for (const operation of ["read", "write"] as const) {
    app.post(`/v1/private-evidence/${operation}`, async c => {
      try {
        // Queries/cookies must never become a credential fallback; no CORS allowance.
        if (new URL(c.req.url).search || c.req.header("cookie")) throw deny();
        const authorization = c.req.header("authorization");
        if (!authorization) throw deny();
        const scope: EvidenceScope = operation === "write" ? "evidence:write" : "evidence:read";
        const authenticate = () => authenticateEvidence({ authorization, scope, network: trusted.network,
          issuer: trusted.issuer, audience: trusted.audience, keys: trusted.keys,
          activeIdentity: createIssuerEvidenceIdentityCheck({ issuer: trusted.issuer, authorization, scope,
            isMerchantActive: trusted.isMerchantActive, fetcher: trusted.issuerFetcher }) });
        await authenticate(); // Before buffering any user-supplied content.
        const body = await readPrivateEvidenceJson(c.req.raw);
        const parsed = operation === "write" ? writeSchema.parse(body) : readSchema.parse(body);
        const context = Object.freeze(validateEvidenceContext(parsed.context));
        const authorize = async () => {
          const identity = await authenticate(); // Never cache identity across asynchronous operations.
          await authorizeEvidence({ identity, scope, context, network: trusted.network,
            allowedContracts: trusted.allowedContracts, readJob: trusted.readJob });
        };
        await authorize(); // Before even entering the storage adapter.
        if (operation === "write") {
          const bytes = Buffer.from(writeSchema.parse(body).content, "utf8");
          if (bytes.length !== context.sizeBytes || bytes.length > 8192) throw deny();
          const receipt = await trusted.store.put(context, bytes, authorize);
          return c.json({ sha256: context.sha256, ...receipt }, receipt.created ? 201 : 200);
        }
        const bytes = await trusted.store.get(context, authorize);
        await authorize(); // Check again immediately before exposing plaintext to the response.
        c.header("Content-Type", context.mediaType);
        c.header("Content-Disposition", 'attachment; filename="evidence"');
        return c.body(new Uint8Array(bytes));
      } catch {
        void c.req.raw.body?.cancel().catch(() => undefined);
        return c.json({ error: "private_evidence_access_denied" }, 403);
      }
    });
  }
  return app;
}
