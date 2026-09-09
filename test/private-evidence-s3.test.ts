import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), post: vi.fn(), sign: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mocks.send; },
  HeadObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost: mocks.post }));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: mocks.sign }));
import { createS3EvidenceObjects } from "../src/private-evidence-s3.js";
const context = { network: "testnet" as const,
  contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5", jobId: "1",
  provider: "ST10T9RQQX1D1XRGA9QV3J6AP8FDFNTQ1BXJZ3NEP", mediaType: "text/plain" as const,
  sizeBytes: 5, sha256: "a".repeat(64) };
const key = "private-evidence/testnet/11111111-1111-4111-8111-111111111111";
const checksum = Buffer.from(context.sha256, "hex").toString("base64");
const adapter = () => createS3EvidenceObjects({ bucket: "nayori-fixture-only", region: "us-east-1", accountId: "123456789012" });
beforeEach(() => vi.resetAllMocks());
describe("S3 direct adapter command contracts (mocked AWS)", () => {
  it("signs exact key, size, content type, SHA256 and encryption for five minutes", async () => {
    await adapter().upload(key, context, 300);
    const request = mocks.post.mock.calls[0]![1];
    expect(request.Key).toBe(key); expect(request.Expires).toBe(300);
    expect(request.Conditions).toContainEqual(["content-length-range", 5, 5]);
    expect(request.Conditions).toContainEqual({ "x-amz-checksum-sha256": checksum });
    expect(request.Conditions).toContainEqual({ "x-amz-server-side-encryption": "AES256" });
  });
  it("verifies owner, checksum and non-null S3 version", async () => {
    mocks.send.mockResolvedValue({ VersionId: "v1", ContentLength: 5, ContentType: "text/plain",
      ChecksumSHA256: checksum, ServerSideEncryption: "AES256" });
    expect(await adapter().verify(key, context)).toEqual({ key, versionId: "v1", checksum, size: 5, mediaType: "text/plain" });
    expect(mocks.send.mock.calls[0]![0].input).toMatchObject({ ChecksumMode: "ENABLED", ExpectedBucketOwner: "123456789012" });
  });
  it.each([
    { VersionId: "null" }, { VersionId: undefined }, { ContentLength: 6 }, { ContentType: "text/html" },
    { ChecksumSHA256: "other" }, { ServerSideEncryption: undefined }, { DeleteMarker: true },
  ])("rejects unverified object %j", async change => {
    mocks.send.mockResolvedValue({ VersionId: "v1", ContentLength: 5, ContentType: "text/plain",
      ChecksumSHA256: checksum, ServerSideEncryption: "AES256", ...change });
    await expect(adapter().verify(key, context)).rejects.toThrow();
  });
  it("pins GET to stored version and forces download/no-store", async () => {
    await adapter().download({ key, versionId: "v1", checksum, size: 5, mediaType: "text/plain" }, 60);
    expect(mocks.sign.mock.calls[0]![1].input).toMatchObject({ VersionId: "v1", ResponseCacheControl: "no-store",
      ResponseContentType: "application/octet-stream", ResponseContentDisposition: 'attachment; filename="evidence"' });
  });
  it("rejects arbitrary keys, TTL and bucket config", async () => {
    await expect(adapter().upload("../other", context, 300)).rejects.toThrow();
    await expect(adapter().upload(key, context, 301)).rejects.toThrow();
    expect(() => createS3EvidenceObjects({ bucket: "https://attacker", region: "us-east-1", accountId: "123456789012" })).toThrow();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
