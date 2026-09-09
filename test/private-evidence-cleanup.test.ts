import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mocks.send; },
  ListObjectVersionsCommand: class { kind = "list"; constructor(public input: unknown) {} },
  DeleteObjectCommand: class { kind = "delete"; constructor(public input: unknown) {} },
}));
import { createS3EvidenceCleanup } from "../src/private-evidence-cleanup.js";
const key = "private-evidence/testnet/11111111-1111-4111-8111-111111111111";
const adapter = () => createS3EvidenceCleanup({ bucket: "fixture-qa-bucket", region: "us-east-1", accountId: "123456789012",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" } });
beforeEach(() => vi.resetAllMocks());
describe("exact-version operator cleanup", () => {
  it("deletes only enumerated versions and verifies empty", async () => {
    mocks.send.mockResolvedValueOnce({ Versions: [{ Key: key, VersionId: "v1" }], DeleteMarkers: [{ Key: key, VersionId: "marker" }] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({});
    expect(await adapter().removeExactKey(key)).toBe(2);
    expect(mocks.send.mock.calls[1]![0].input).toMatchObject({ Key: key, VersionId: "v1" });
    expect(mocks.send.mock.calls[2]![0].input).toMatchObject({ Key: key, VersionId: "marker" });
  });
  it.each([{ IsTruncated: true }, { Versions: [{ Key: "other", VersionId: "v1" }] },
    { Versions: [{ Key: key, VersionId: "null" }] }, { Versions: Array.from({ length: 101 }, (_, i) => ({ Key: key, VersionId: String(i) })) }])("rejects unsafe inventory %# before deletion", async result => {
    mocks.send.mockResolvedValue(result);
    await expect(adapter().removeExactKey(key)).rejects.toThrow();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong network and broad prefix without I/O", async () => {
    await expect(adapter().removeExactKey(key.replace("testnet", "mainnet"))).rejects.toThrow();
    await expect(adapter().removeExactKey("private-evidence/testnet/")).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("fails if deletion fails or residual versions remain", async () => {
    mocks.send.mockResolvedValueOnce({ Versions: [{ Key: key, VersionId: "v1" }] }).mockRejectedValueOnce(Error("unavailable"));
    await expect(adapter().removeExactKey(key)).rejects.toThrow();
    mocks.send.mockReset().mockResolvedValueOnce({}).mockResolvedValueOnce({ Versions: [{ Key: key, VersionId: "late" }] });
    await expect(adapter().removeExactKey(key)).rejects.toThrow("evidence_cleanup_incomplete");
  });
});
