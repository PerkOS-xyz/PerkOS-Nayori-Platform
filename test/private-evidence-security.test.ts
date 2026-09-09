import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { authenticateEvidence, authorizeEvidence, sealEvidence, openEvidence,
  type PrivateEvidenceContext, type PrivateEvidenceJob, type EvidenceIdentity } from "../src/private-evidence-security.js";

const client = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const evaluator = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const stranger = "ST1E7E64H8VSSSGE0RPWF90RRC91MQG7CRQRM1BFX";
const bytes = Buffer.from('{"private":"fixture-not-a-secret"}');
const ctx: PrivateEvidenceContext = { network: "testnet", contract: `${client}.sbtc-commerce-v5`, jobId: "1", provider,
  sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "application/json", sizeBytes: bytes.length };
const identity = (walletAddress: string): EvidenceIdentity => ({ walletAddress, merchantId: "merchant", clientId: `ny_oc_${"a".repeat(24)}` });
const job: PrivateEvidenceJob = { network: "testnet", contract: ctx.contract, jobId: "1", client, provider, evaluator, status: 1, escrow: 1000n };
const base = { network: "testnet" as const, allowedContracts: [ctx.contract], context: ctx };
const denied = "private_evidence_access_denied";
describe("private evidence access policy (not an HTTP/storage integration)", () => {
  it("lets only assigned provider write funded evidence", async () => {
    const readJob = vi.fn().mockResolvedValue(job);
    expect(await authorizeEvidence({ ...base, identity: identity(provider), scope: "evidence:write", readJob })).toBe("provider");
    expect(readJob).toHaveBeenCalledExactlyOnceWith(ctx.contract, "1");
  });
  it.each([client, evaluator, stranger])("rejects write from non-provider %s", async walletAddress => {
    await expect(authorizeEvidence({ ...base, identity: identity(walletAddress), scope: "evidence:write", readJob: async () => job })).rejects.toThrow(denied);
  });
  it.each([0, 2, 3, 4, 5, 6, 7, 8])("rejects upload after/before funded state %s", async status => {
    await expect(authorizeEvidence({ ...base, identity: identity(provider), scope: "evidence:write", readJob: async () => ({ ...job, status }) })).rejects.toThrow(denied);
  });
  it.each([client, provider])("allows participant reads after settlement %s", async address => {
    expect(await authorizeEvidence({ ...base, identity: identity(address), scope: "evidence:read", readJob: async () => ({ ...job, status: 3, escrow: 0n }) })).toBe(address === client ? "consumer" : "provider");
  });
  it.each([2, 7, 8])("allows designated evaluator only during processing state %s", async status => {
    expect(await authorizeEvidence({ ...base, identity: identity(evaluator), scope: "evidence:read", readJob: async () => ({ ...job, status }) })).toBe("evaluator");
  });
  it.each([0, 1, 3, 4, 5, 6])("denies evaluator outside review state %s", async status => {
    await expect(authorizeEvidence({ ...base, identity: identity(evaluator), scope: "evidence:read", readJob: async () => ({ ...job, status }) })).rejects.toThrow(denied);
  });
  it.each([
    { provider: stranger }, { provider: null }, { network: "mainnet" as const }, { jobId: "2" },
    { contract: `${client}.other` }, { escrow: 0n }, { client: provider }, { status: 99 },
  ])("fails closed for wrong/changed chain binding case %#", async override => {
    await expect(authorizeEvidence({ ...base, identity: identity(provider), scope: "evidence:write", readJob: async () => ({ ...job, ...override }) })).rejects.toThrow(denied);
  });
  it("rejects stranger reads and missing jobs without exposing contents", async () => {
    for (const current of [job, null]) await expect(authorizeEvidence({ ...base, identity: identity(stranger), scope: "evidence:read", readJob: async () => current })).rejects.toThrow(denied);
  });
  it("rejects foreign contract before RPC and sanitizes chain failure", async () => {
    const readJob = vi.fn().mockRejectedValue(Error("PRIVATE CHAIN RESPONSE"));
    await expect(authorizeEvidence({ ...base, allowedContracts: [], identity: identity(client), scope: "evidence:read", readJob })).rejects.toThrow(denied);
    expect(readJob).not.toHaveBeenCalled();
    await expect(authorizeEvidence({ ...base, identity: identity(client), scope: "evidence:read", readJob })).rejects.toThrow(denied);
  });
});

describe("encrypted evidence envelope", () => {
  it("uses randomized authenticated encryption, with no plaintext in its envelope", () => {
    const key = randomBytes(32), one = sealEvidence(bytes, ctx, "key1", key), two = sealEvidence(bytes, ctx, "key1", key);
    expect(one.iv).not.toBe(two.iv); expect(one.ciphertext).not.toBe(two.ciphertext);
    expect(JSON.stringify(one)).not.toContain("fixture-not-a-secret");
    expect(openEvidence(one, ctx, "key1", key)).toEqual(bytes);
  });
  it.each(["jobId", "contract", "provider", "sha256", "mediaType", "sizeBytes"])("rejects swapped authenticated context %s", field => {
    const key = randomBytes(32), sealed = sealEvidence(bytes, ctx, "key1", key);
    const change = { jobId: "2", contract: `${client}.other`, provider: stranger,
      sha256: "a".repeat(64), mediaType: "text/plain", sizeBytes: bytes.length - 1 };
    expect(() => openEvidence(sealed, { ...ctx, [field]: change[field as keyof typeof change] }, "key1", key)).toThrow(denied);
  });
  it.each(["iv", "tag", "ciphertext", "keyId", "version"])("rejects tampered envelope %s", field => {
    const key = randomBytes(32), sealed = sealEvidence(bytes, ctx, "key1", key);
    const changes = { iv: "00".repeat(12), tag: "00".repeat(16), ciphertext: Buffer.alloc(bytes.length).toString("base64"), keyId: "other", version: 2 };
    expect(() => openEvidence({ ...sealed, [field]: changes[field as keyof typeof changes] }, ctx, "key1", key)).toThrow(denied);
  });
  it("rejects wrong key and extra fields", () => {
    const key = randomBytes(32), sealed = sealEvidence(bytes, ctx, "key1", key);
    expect(() => openEvidence(sealed, ctx, "key1", randomBytes(32))).toThrow(denied);
    expect(() => openEvidence({ ...sealed, plaintext: "unsafe" }, ctx, "key1", key)).toThrow(denied);
    expect(() => sealEvidence(bytes, ctx, "key1", randomBytes(16))).toThrow(denied);
  });
  it.each([Buffer.from("invalid-json"), Buffer.from([0xff]), Buffer.alloc(8193)])("rejects invalid bytes before encryption", input => {
    const expected = { ...ctx, sizeBytes: input.length, sha256: createHash("sha256").update(input).digest("hex") };
    expect(() => sealEvidence(input, expected, "key1", randomBytes(32))).toThrow(denied);
  });
  it("rejects a false plaintext digest", () => expect(() => sealEvidence(bytes, { ...ctx, sha256: "0".repeat(64) }, "key1", randomBytes(32))).toThrow(denied));
});

describe("wallet-bound private evidence authentication", () => {
  const now = new Date("2026-09-09T12:00:00Z"), seconds = now.getTime() / 1000;
  async function fixture(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const { publicKey, privateKey } = await generateKeyPair("EdDSA");
    const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test" }] });
    const payload = { iss: "https://oauth.qa.nayori.ai", aud: "https://api.qa.nayori.ai", sub: "merchant",
      client_id: identity(provider).clientId, wallet_address: provider, scope: "evidence:read evidence:write",
      iat: seconds, exp: seconds + 300, ...overrides };
    for (const k of Object.keys(payload)) if ((payload as Record<string, unknown>)[k] === undefined) delete (payload as Record<string, unknown>)[k];
    const token = await new SignJWT(payload).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "test", ...header }).sign(privateKey);
    const activeIdentity = vi.fn().mockResolvedValue(true);
    return { authorization: `Bearer ${token}`, scope: "evidence:read" as const, network: "testnet" as const,
      issuer: "https://oauth.qa.nayori.ai", audience: "https://api.qa.nayori.ai", keys, now, activeIdentity };
  }
  it("returns the verified wallet/client/tenant and checks authoritative activation", async () => {
    const f = await fixture(); const result = await authenticateEvidence(f);
    expect(result).toEqual(identity(provider)); expect(Object.isFrozen(result)).toBe(true);
    expect(f.activeIdentity).toHaveBeenCalledExactlyOnceWith(identity(provider));
  });
  it.each([
    { iss: "https://attacker.example" }, { aud: "https://other.example" }, { exp: seconds - 1 },
    { exp: undefined }, { iat: undefined }, { iat: seconds + 100 }, { exp: seconds + 3600 },
    { wallet_address: "invalid" }, { wallet_address: undefined }, { client_id: "invalid" },
    { scope: "mcp:invoke" }, { scope: "evidence:read evidence:read" }, { sub: undefined },
  ])("rejects invalid identity/scope/expiry claims %j", async changes => {
    const f = await fixture(changes); await expect(authenticateEvidence(f)).rejects.toThrow(denied);
    expect(f.activeIdentity).not.toHaveBeenCalled();
  });
  it.each([{ typ: "JWT" }, { jku: "https://attacker.example/keys" }])("rejects inappropriate headers %j", async header => {
    await expect(authenticateEvidence(await fixture({}, header))).rejects.toThrow(denied);
  });
  it("rejects merchant API keys, missing auth and a cross-network wallet", async () => {
    const f = await fixture();
    for (const authorization of [undefined, "Bearer ny_mk_" + "a".repeat(43), "Basic abc"])
      await expect(authenticateEvidence({ ...f, authorization })).rejects.toThrow(denied);
    await expect(authenticateEvidence({ ...f, network: "mainnet" })).rejects.toThrow(denied);
  });
  it("rejects inactive/revoked identity and unavailable registry", async () => {
    const f = await fixture(); f.activeIdentity.mockResolvedValue(false);
    await expect(authenticateEvidence(f)).rejects.toThrow(denied);
    f.activeIdentity.mockRejectedValue(Error("PRIVATE CLIENT DATABASE"));
    await expect(authenticateEvidence(f)).rejects.toThrow(denied);
  });
});
