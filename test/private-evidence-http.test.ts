import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createPrivateEvidenceHttp } from "../src/private-evidence-http.js";

const consumer = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const evaluator = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const issuer = "https://oauth.qa.nayori.ai", audience = "https://qa.nayori.ai";
const content = "private fixture", bytes = Buffer.from(content);
const context = { network: "testnet" as const, contract: `${consumer}.sbtc-commerce-v5`, jobId: "1", provider,
  sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "text/plain", sizeBytes: bytes.length };
async function fixture(wallet = provider) {
  const pair = await generateKeyPair("EdDSA");
  const publicKey = await exportJWK(pair.publicKey);
  const clientId = `ny_oc_${"a".repeat(24)}`;
  const token = await new SignJWT({ client_id: clientId, wallet_address: wallet, scope: "evidence:read evidence:write" })
    .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "fixture" }).setIssuer(issuer).setAudience(audience)
    .setSubject("tenant").setIssuedAt().setExpirationTime("10m").sign(pair.privateKey);
  let active = true;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify({ active: true, clientId,
    walletAddress: wallet, merchantId: "tenant", scope: new Headers(init?.headers).get("x-nayori-evidence-scope"),
    expiresAt: Math.floor(Date.now()/1000)+600 }), { headers: { "content-type": "application/json" } }));
  const store = {
    put: vi.fn(async (_c, _b, authorize: () => Promise<void>) => { await authorize(); return { created: true, expiresAt: "2099-01-01T00:00:00Z" }; }),
    get: vi.fn(async (_c, authorize: () => Promise<void>) => { await authorize(); return bytes; }),
  };
  const readJob = vi.fn(async () => ({ network: "testnet" as const, contract: context.contract, jobId: "1",
    client: consumer, provider, evaluator, status: 1, escrow: 1000n }));
  const app = createPrivateEvidenceHttp({ network: "testnet", allowedContracts: [context.contract], issuer, audience,
    keys: createLocalJWKSet({ keys: [{ ...publicKey, kid: "fixture" }] }), isMerchantActive: async () => active,
    readJob, store, issuerFetcher: fetcher });
  const request = (operation = "write", body: unknown = { context, content }, headers: Record<string,string> = {}) =>
    app.request(`/v1/private-evidence/${operation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, store, request, readJob, fetcher, authorization: `Bearer ${token}`, revoke: () => { active = false; } };
}
describe("inactive private HTTP factory", () => {
  it("writes through fresh token, issuer and job checks and returns no public URL", async () => {
    const f = await fixture(); const response = await f.request();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sha256: context.sha256, created: true, expiresAt: "2099-01-01T00:00:00Z" });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.readJob).toHaveBeenCalledTimes(2);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("allows consumer read as attachment without cache/CORS", async () => {
    const f = await fixture(consumer); const response = await f.request("read", { context });
    expect(response.status).toBe(200); expect(await response.text()).toBe(content);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("denies consumer upload before storage", async () => {
    const f = await fixture(consumer); expect((await f.request()).status).toBe(403); expect(f.store.put).not.toHaveBeenCalled();
  });
  it("denies revoked identity before chain/storage", async () => {
    const f = await fixture(); f.revoke(); expect((await f.request()).status).toBe(403);
    expect(f.readJob).not.toHaveBeenCalled(); expect(f.store.put).not.toHaveBeenCalled();
  });
  it("denies revocation after storage read before returning plaintext", async () => {
    const f = await fixture(); f.store.get.mockImplementationOnce(async () => { f.revoke(); return bytes; });
    const response = await f.request("read", { context }); expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(content);
  });
  it.each<Record<string, string>>([{ authorization: "Bearer ny_mk_fixture" }, { cookie: "session=fixture" }, { "content-encoding": "gzip" }, { "content-type": "text/plain" }])("rejects unsupported credentials/transport %#", async headers => {
    const f = await fixture(); expect((await f.request("write", { context, content }, headers)).status).toBe(403);
    expect(f.store.put).not.toHaveBeenCalled();
  });
  it.each([{ context: { ...context, jobId: "2" }, content }, { context, content, url: "https://attacker.invalid" }, { context, content: "x" }, { context, content: "x".repeat(70000) }])("rejects invalid bindings/body %#", async body => {
    const f = await fixture(); expect((await f.request("write", body)).status).toBe(403); expect(f.store.put).not.toHaveBeenCalled();
  });
  it("sanitizes database failures and exposes no anonymous GET", async () => {
    const f = await fixture(); f.store.put.mockRejectedValueOnce(Error("PRIVATE SQL"));
    const response = await f.request(); expect(response.status).toBe(403);
    expect(await response.text()).toBe('{"error":"private_evidence_access_denied"}');
    expect((await f.app.request("/v1/private-evidence/read")).status).toBe(404);
  });
  it("rejects query credentials before identity lookup", async () => {
    const f = await fixture();
    const response = await f.app.request("/v1/private-evidence/read?token=fixture", { method: "POST" });
    expect(response.status).toBe(403); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rechecks provider assignment inside the storage callback", async () => {
    const f = await fixture();
    f.store.put.mockImplementationOnce(async (_c, _bytes, authorize) => {
      f.readJob.mockResolvedValue({ network: "testnet", contract: context.contract, jobId: "1", client: consumer,
        provider: evaluator, evaluator: provider, status: 1, escrow: 1000n });
      await authorize(); return { created: true, expiresAt: "2099-01-01T00:00:00Z" };
    });
    expect((await f.request()).status).toBe(403);
  });
  it("bounds slow streaming bodies and cancels their reader", async () => {
    const f = await fixture(); const cancel = vi.fn();
    vi.useFakeTimers();
    try {
      const response = f.app.request("/v1/private-evidence/write", { method: "POST", headers: {
        authorization: f.authorization, "content-type": "application/json" },
        body: new ReadableStream({ cancel }), duplex: "half" } as RequestInit);
      // Crypto verification is real asynchronous I/O; wait until the issuer call before advancing.
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5100);
      expect((await response).status).toBe(403); expect(cancel).toHaveBeenCalled();
      expect(f.store.put).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
