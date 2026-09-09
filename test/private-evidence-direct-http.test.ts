import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createDirectEvidenceHttp } from "../src/private-evidence-direct-http.js";
import { createDirectEvidenceService, type DirectEvidenceRecord } from "../src/private-evidence-direct.js";

const consumer = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const evaluator = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const context = { network: "testnet" as const, contract: `${consumer}.sbtc-commerce-v5`, provider,
  jobId: "1", sha256: "a".repeat(64), mediaType: "text/plain" as const, sizeBytes: 5 };
async function fixture(wallet = provider) {
  const pair = await generateKeyPair("EdDSA"), pub = await exportJWK(pair.publicKey);
  const issuer = "https://oauth.qa.nayori.ai", audience = "https://qa.nayori.ai", clientId = `ny_oc_${"a".repeat(24)}`;
  const token = await new SignJWT({ client_id: clientId, wallet_address: wallet, scope: "evidence:read evidence:write" })
    .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "fixture" }).setIssuer(issuer).setAudience(audience)
    .setSubject("tenant").setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  const rows = new Map<string, DirectEvidenceRecord>();
  const upload = vi.fn(async () => ({ url: "https://fixture.s3.us-east-1.amazonaws.com", fields: {} }));
  const service = createDirectEvidenceService({ retentionSeconds: 3600,
    metadata: { reserve: async r => { rows.set(r.id, r); }, find: async id => rows.get(id) ?? null,
      finalize: async (id, object) => { const r = rows.get(id)!; r.object ??= object; return r; } },
    objects: { upload, verify: async key => ({ key, versionId: "v1", checksum: Buffer.from(context.sha256, "hex").toString("base64"), size: 5, mediaType: "text/plain" }),
      download: async () => "https://fixture.s3.us-east-1.amazonaws.com/file?signature=fixture" } });
  let active = true;
  const app = createDirectEvidenceHttp({ network: "testnet", allowedContracts: [context.contract], issuer, audience,
    keys: createLocalJWKSet({ keys: [{ ...pub, kid: "fixture" }] }), isMerchantActive: async () => active,
    readJob: async () => ({ network: "testnet", contract: context.contract, jobId: "1", client: consumer,
      provider, evaluator, status: 1, escrow: 1000n }), service,
    issuerFetcher: async (_url, init) => new Response(JSON.stringify({ active: true, clientId, walletAddress: wallet,
      merchantId: "tenant", scope: new Headers(init?.headers).get("x-nayori-evidence-scope"), expiresAt: Math.floor(Date.now()/1000)+600 }),
    { headers: { "content-type": "application/json" } }) });
  const request = (op: string, body: unknown, headers: Record<string, string> = {}) => app.request(`/v1/private-evidence/${op}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, request, upload, rows, revoke: () => { active = false; } };
}
describe("direct S3 HTTP with real JWT checks and fixture storage", () => {
  it("runs prepare/complete/download with no cache", async () => {
    const f = await fixture(); const p = await f.request("prepare", { context });
    expect(p.status).toBe(201); const { id } = await p.json() as { id: string };
    expect((await f.request("complete", { id })).status).toBe(200);
    const d = await f.request("download", { id }); expect(d.status).toBe(200);
    expect(d.headers.get("cache-control")).toBe("no-store");
    expect(d.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("rejects consumer upload and revoked identity", async () => {
    const c = await fixture(consumer); expect((await c.request("prepare", { context })).status).toBe(403);
    expect(c.upload).not.toHaveBeenCalled();
    const f = await fixture(); f.revoke(); expect((await f.request("prepare", { context })).status).toBe(403);
    expect(f.rows.size).toBe(0);
  });
  it.each<Record<string, string>>([{ authorization: "Bearer ny_mk_fixture" }, { cookie: "session=fixture" }, { "content-type": "text/plain" }])("rejects credential/transport override %j", async headers => {
    const f = await fixture(); expect((await f.request("prepare", { context }, headers)).status).toBe(403);
    expect(f.rows.size).toBe(0);
  });
  it("rejects cross-job contexts, client metadata at completion, anonymous GET and oversized body", async () => {
    const f = await fixture();
    expect((await f.request("prepare", { context: { ...context, jobId: "2" } })).status).toBe(403);
    const p = await f.request("prepare", { context }); const { id } = await p.json() as { id: string };
    expect((await f.request("complete", { id, versionId: "injected" })).status).toBe(403);
    expect((await f.request("prepare", { context, padding: "x".repeat(70000) })).status).toBe(403);
    expect((await f.app.request("/v1/private-evidence/download")).status).toBe(404);
  });
});
