import { z } from "zod";
import type { EvidenceIdentity, EvidenceScope } from "./private-evidence-security.js";

const responseSchema = z.object({
  active: z.literal(true), clientId: z.string().max(64), walletAddress: z.string().max(64),
  merchantId: z.string().max(64), scope: z.enum(["evidence:read", "evidence:write"]),
  expiresAt: z.number().int().positive(),
}).strict();

async function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(Error("identity_timeout"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/**
 * Build per request, using the same bearer token verified by authenticateEvidence.
 * This checks issuer client status AND local tenant status, never job access.
 * No default issuer, network fallback, API-key fallback or authorization cache.
 */
export function createIssuerEvidenceIdentityCheck(options: {
  issuer: string; authorization: string; scope: EvidenceScope;
  isMerchantActive: (merchantId: string) => Promise<boolean>;
  fetcher?: typeof fetch; now?: () => number;
}) {
  const issuer = new URL(options.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash ||
      issuer.pathname !== "/" || !options.authorization.startsWith("Bearer ") ||
      options.authorization.length > 8192 || options.authorization.slice(7).split(".").length !== 3 ||
      !["evidence:read", "evidence:write"].includes(options.scope)) {
    throw new Error("invalid_evidence_issuer_configuration");
  }
  const endpoint = new URL("/oauth/evidence/identity", issuer).href;
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  return async (identity: EvidenceIdentity): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      if (!await withinDeadline(options.isMerchantActive(identity.merchantId), controller.signal)) return false;
      const response = await withinDeadline(fetcher(endpoint, { method: "POST", redirect: "error", cache: "no-store",
        credentials: "omit", signal: controller.signal,
        headers: { authorization: options.authorization, "x-nayori-evidence-scope": options.scope, accept: "application/json" } }), controller.signal);
      if (controller.signal.aborted || response.status !== 200 || response.redirected ||
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => undefined); return false;
      }
      const reader = response.body?.getReader();
      if (!reader) return false;
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const item = await withinDeadline(reader.read(), controller.signal);
          if (item.done) break;
          size += item.value.length;
          if (size > 1024 || controller.signal.aborted) throw Error("invalid_identity_response");
          chunks.push(item.value);
        }
      } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const result = responseSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
      if (!result.success || controller.signal.aborted) return false;
      const value = result.data;
      if (value.clientId !== identity.clientId || value.walletAddress !== identity.walletAddress ||
          value.merchantId !== identity.merchantId || value.scope !== options.scope ||
          value.expiresAt <= Math.floor(now() / 1000) || value.expiresAt > Math.floor(now() / 1000) + 900) return false;
      return await withinDeadline(options.isMerchantActive(identity.merchantId), controller.signal) && !controller.signal.aborted;
    } catch { return false; }
    finally { clearTimeout(timer); controller.abort(); }
  };
}
