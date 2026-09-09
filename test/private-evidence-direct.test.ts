import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDirectEvidenceService, type DirectEvidenceRecord } from "../src/private-evidence-direct.js";
import type { EvidenceObject } from "../src/private-evidence-s3.js";

const context = { network: "testnet" as const,
  contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5", jobId: "1",
  provider: "ST10T9RQQX1D1XRGA9QV3J6AP8FDFNTQ1BXJZ3NEP", mediaType: "text/plain" as const,
  sizeBytes: 5, sha256: createHash("sha256").update("hello").digest("hex") };
function fixture() {
  let time = Date.now();
  const rows = new Map<string, DirectEvidenceRecord>();
  const authorize = vi.fn(async () => {});
  const objects = {
    upload: vi.fn(async () => ({ url: "https://fixture.s3.us-east-1.amazonaws.com", fields: {} })),
    verify: vi.fn(async (key: string): Promise<EvidenceObject> => ({ key, versionId: "version-one",
      checksum: Buffer.from(context.sha256, "hex").toString("base64"), size: 5, mediaType: "text/plain" })),
    download: vi.fn(async () => "https://fixture.s3.us-east-1.amazonaws.com/file?signature=fixture"),
  };
  const metadata = {
    reserve: vi.fn(async (r: DirectEvidenceRecord) => { rows.set(r.id, structuredClone(r)); }),
    find: vi.fn(async (id: string) => structuredClone(rows.get(id) ?? null)),
    finalize: vi.fn(async (id: string, o: EvidenceObject) => {
      const r = rows.get(id)!; r.object ??= o; return structuredClone(r);
    }),
  };
  const service = createDirectEvidenceService({ metadata, objects, retentionSeconds: 3600, now: () => time });
  return { service, rows, objects, metadata, authorize, advance: (ms: number) => { time += ms; } };
}
describe("direct evidence state boundary", () => {
  it("reserves before signing, verifies S3, stores version, and downloads that exact version", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    expect(f.metadata.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.objects.upload.mock.invocationCallOrder[0]!);
    expect(f.rows.get(p.id)?.object).toBeNull();
    await f.service.complete(p.id, f.authorize);
    await f.service.download(p.id, f.authorize);
    expect(f.objects.download).toHaveBeenCalledWith(expect.objectContaining({ versionId: "version-one" }), 60);
  });
  it("refuses pending downloads", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    await expect(f.service.download(p.id, f.authorize)).rejects.toThrow();
    expect(f.objects.download).not.toHaveBeenCalled();
  });
  it("cannot sign without permission or quota reservation", async () => {
    const f = fixture(); f.authorize.mockRejectedValueOnce(Error("revoked"));
    await expect(f.service.prepare(context, f.authorize)).rejects.toThrow();
    expect(f.metadata.reserve).not.toHaveBeenCalled();
    f.metadata.reserve.mockRejectedValueOnce(Error("quota"));
    await expect(f.service.prepare(context, f.authorize)).rejects.toThrow();
    expect(f.objects.upload).not.toHaveBeenCalled();
  });
  it.each(["key", "versionId", "checksum", "mediaType", "size"] as const)("refuses mismatched verified %s", async field => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    const o = await f.objects.verify(f.rows.get(p.id)!.key);
    f.objects.verify.mockResolvedValueOnce({ ...o, [field]: field === "size" ? 9 : field === "versionId" ? "null" : "wrong" });
    await expect(f.service.complete(p.id, f.authorize)).rejects.toThrow();
    expect(f.metadata.finalize).not.toHaveBeenCalled();
  });
  it("completion retries never repin a later upload version or extend expiry", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    await f.service.complete(p.id, f.authorize); f.advance(310000);
    const r = await f.service.complete(p.id, f.authorize);
    expect(f.objects.verify).toHaveBeenCalledTimes(1); expect(r.expiresAt).toBe(p.expiresAt);
  });
  it("rejects expired pending uploads", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize); f.advance(300000);
    await expect(f.service.complete(p.id, f.authorize)).rejects.toThrow();
    expect(f.objects.verify).not.toHaveBeenCalled();
  });
  it("bounds download by retention and rejects expiry", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    await f.service.complete(p.id, f.authorize); f.advance(3590000);
    expect((await f.service.download(p.id, f.authorize)).expiresIn).toBe(10);
    f.advance(10000); await expect(f.service.download(p.id, f.authorize)).rejects.toThrow();
  });
  it("reauthorizes after head and before returning signed download", async () => {
    const f = fixture(), p = await f.service.prepare(context, f.authorize);
    f.authorize.mockResolvedValueOnce().mockRejectedValueOnce(Error("revoked"));
    await expect(f.service.complete(p.id, f.authorize)).rejects.toThrow();
    expect(f.metadata.finalize).not.toHaveBeenCalled();
    await f.service.complete(p.id, f.authorize);
    f.authorize.mockResolvedValueOnce().mockRejectedValueOnce(Error("revoked"));
    await expect(f.service.download(p.id, f.authorize)).rejects.toThrow();
  });
  it("rejects arbitrary IDs and additional metadata", async () => {
    const f = fixture();
    await expect(f.service.complete("../../other", f.authorize)).rejects.toThrow();
    await expect(f.service.prepare({ ...context, bucket: "other" }, f.authorize)).rejects.toThrow();
  });
});
