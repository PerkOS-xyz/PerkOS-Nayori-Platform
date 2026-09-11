import { describe, expect, it, vi } from "vitest";
import { createIssuerEvidenceIdentityCheck } from "../src/evidence-issuer-client.js";

const identity = { clientId: `ny_oc_${"a".repeat(24)}`, walletAddress: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", merchantId: "fixture" };
const now = 1_800_000_000_000;
const payload = { active: true, ...identity, scope: "evidence:read", expiresAt: now / 1000 + 120 };
function fixture(override: Record<string, unknown> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ...payload, ...override }));
  const isMerchantActive = vi.fn(async () => true);
  const options = { issuer: "https://oauth.qa.nayori.ai", authorization: "Bearer fixture.signed.token",
    scope: "evidence:read" as const, isMerchantActive, fetcher, now: () => now };
  return { options, fetcher, isMerchantActive, check: createIssuerEvidenceIdentityCheck(options) };
}
describe("issuer evidence identity client (inactive runtime adapter)", () => {
  it("uses fixed HTTPS endpoint, headers only, no redirects/cache/cookies", async () => {
    const f = fixture(); expect(await f.check(identity)).toBe(true);
    expect(f.fetcher).toHaveBeenCalledWith("https://oauth.qa.nayori.ai/oauth/evidence/identity", expect.objectContaining({
      method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
      headers: { authorization: "Bearer fixture.signed.token", "x-nayori-evidence-scope": "evidence:read", accept: "application/json" },
    }));
    expect(f.isMerchantActive).toHaveBeenCalledTimes(2);
  });
  it.each([
    { active: false }, { clientId: "other" }, { walletAddress: "other" }, { merchantId: "other" },
    { scope: "evidence:write" }, { expiresAt: now / 1000 }, { expiresAt: now / 1000 + 901 },
    { extra: "not-permitted" }, { scope: "agent:self" },
  ])("denies wrong/revoked/stale response %#", async override => {
    expect(await fixture(override).check(identity)).toBe(false);
  });
  it("does not cache a prior active result", async () => {
    const f = fixture(); expect(await f.check(identity)).toBe(true);
    f.fetcher.mockResolvedValue(Response.json({ error: "evidence_identity_denied" }, { status: 401 }));
    expect(await f.check(identity)).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("denies inactive tenants before sending token and detects later revocation", async () => {
    const f = fixture(); f.isMerchantActive.mockResolvedValue(false);
    expect(await f.check(identity)).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
    f.isMerchantActive.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.check(identity)).toBe(false);
  });
  it.each([401, 403, 404, 500, 302])("fails closed on status %s", async status => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response("denied", { status }));
    expect(await f.check(identity)).toBe(false);
  });
  it.each([["30",30],[null,60],["0",60],["999",60],["tomorrow",60],["1",1],["300",300]])("bounds issuer retry-after %s", async (header, expected) => {
    const f=fixture();
    f.fetcher.mockResolvedValue(new Response("SECRET UPSTREAM BODY", {status:429, headers:header===null?{}:{"retry-after":String(header)}}));
    await expect(f.check(identity)).rejects.toMatchObject({message:"private_evidence_temporarily_unavailable", retryAfterSeconds:expected});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["oversized", "wrong-mime", "bad-json", "network", "invalid-utf8"])("denies %s", async fault => {
    const f = fixture();
    if (fault === "network") f.fetcher.mockRejectedValue(Error("SECRET NETWORK DETAIL"));
    else f.fetcher.mockResolvedValue(new Response(fault === "oversized" ? "x".repeat(1025) : fault === "invalid-utf8" ? new Uint8Array([255]) : "not-json",
      { headers: { "content-type": fault === "wrong-mime" ? "text/html" : "application/json" } }));
    expect(await f.check(identity)).toBe(false);
  });
  it.each(["http://oauth.example", "https://user:password@oauth.example", "https://oauth.example?token=x", "https://oauth.example/path", "https://oauth.example/#x"])("rejects unsafe configured issuer %s", issuer => {
    expect(() => createIssuerEvidenceIdentityCheck({ ...fixture().options, issuer })).toThrow("invalid_evidence_issuer_configuration");
  });
  it("aborts a stalled request without returning authorization", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true });
      }));
      const result = f.check(identity);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each(["tenant", "body"])("bounds a stalled %s lookup/read", async kind => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      if (kind === "tenant") f.isMerchantActive.mockImplementation(() => new Promise(() => undefined));
      else f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }));
      const result = f.check(identity);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
