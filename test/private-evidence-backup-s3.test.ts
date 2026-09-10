import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mock.send; destroy() {} },
  GetObjectCommand: class { kind = "get"; constructor(public input: unknown) {} },
  PutObjectCommand: class { kind = "put"; constructor(public input: unknown) {} },
  ListObjectVersionsCommand: class { kind = "list"; constructor(public input: unknown) {} },
  DeleteObjectCommand: class { kind = "delete"; constructor(public input: unknown) {} },
}));
import { createS3EvidenceBackup } from "../src/private-evidence-backup-s3.js";
const id = "11111111-1111-4111-8111-111111111111", bytes = Buffer.from("fixture");
const m = { schemaVersion: 1, network: "testnet", sourceKey: `private-evidence/testnet/${id}`, sourceVersion: "original",
  backupKey: `private-evidence-backup/testnet/${id}`, backupVersion: "copy", sha256: createHash("sha256").update(bytes).digest("hex"),
  sizeBytes: bytes.length, mediaType: "text/plain" as const, capturedAt: 1000, expiresAt: 10000, deleteAt: 10000 + 7 * 86400000 };
const expected = { sourceKey: m.sourceKey, sourceVersion: m.sourceVersion, sha256: m.sha256, sizeBytes: m.sizeBytes,
  mediaType: m.mediaType, expiresAt: m.expiresAt };
const response = (version = "copy", manifest = m, data = bytes) => ({ VersionId: version, ContentLength: data.length,
  ContentType: "text/plain", ServerSideEncryption: "AES256", Metadata: { manifest: JSON.stringify(manifest) }, Body: Readable.from([data]) });
const denied = (status: number) => ({ $metadata: { httpStatusCode: status } });
const options = { sourceBucket: "fixture-qa-primary", backupBucket: "fixture-qa-backup", region: "us-east-1", accountId: "123456789012",
  sourceCredentials: { accessKeyId: "fixture-source", secretAccessKey: "fixture" },
  backupCredentials: { accessKeyId: "fixture-backup", secretAccessKey: "fixture" } };
const adapter = (time = 1001) => createS3EvidenceBackup({ ...options, now: () => time });
beforeEach(() => mock.send.mockReset());
it("copies exact source version with conditional creation then verifies stored bytes", async () => {
  mock.send.mockRejectedValueOnce(denied(404)).mockResolvedValueOnce(response("original"))
    .mockResolvedValueOnce({ VersionId: "copy" }).mockResolvedValueOnce(response());
  expect(await adapter().copy(expected)).toEqual(m);
  expect(mock.send.mock.calls[1]![0].input).toMatchObject({ VersionId: "original", ExpectedBucketOwner: options.accountId });
  expect(mock.send.mock.calls[2]![0].input).toMatchObject({ IfNoneMatch: "*", ServerSideEncryption: "AES256" });
});
it("retries without writes or retention extension", async () => {
  mock.send.mockResolvedValueOnce(response());
  expect(await adapter(2000).copy(expected)).toEqual(m);
  expect(mock.send).toHaveBeenCalledTimes(1);
});
it.each([409, 412])("reconciles conditional write conflict %s", async code => {
  mock.send.mockRejectedValueOnce(denied(404)).mockResolvedValueOnce(response("original"))
    .mockRejectedValueOnce(denied(code)).mockResolvedValueOnce(response());
  expect(await adapter().copy(expected)).toEqual(m);
});
it.each([403, 500])("does not treat read failure %s as absence", async code => {
  mock.send.mockRejectedValueOnce(denied(code));
  await expect(adapter().copy(expected)).rejects.toEqual(denied(code));
  expect(mock.send).toHaveBeenCalledTimes(1);
});
it("does not retry ambiguous writes in the same invocation", async () => {
  mock.send.mockRejectedValueOnce(denied(404)).mockResolvedValueOnce(response("original")).mockRejectedValueOnce(Error("timeout"));
  await expect(adapter().copy(expected)).rejects.toThrow("timeout");
  expect(mock.send).toHaveBeenCalledTimes(3);
});
it("rejects altered existing manifest instead of overwriting it", async () => {
  mock.send.mockResolvedValueOnce(response("copy", { ...m, sourceVersion: "other" }));
  await expect(adapter().copy(expected)).rejects.toThrow();
  expect(mock.send).toHaveBeenCalledTimes(1);
});
it("rejects overflowing stream even when content length lies", async () => {
  mock.send.mockResolvedValueOnce({ ...response(), Body: Readable.from([Buffer.alloc(8193)]) });
  await expect(adapter().copy(expected)).rejects.toThrow();
  expect(mock.send).toHaveBeenCalledTimes(1);
});
it("rejects expired source before network access", async () => {
  await expect(adapter(m.expiresAt).copy(expected)).rejects.toThrow();
  expect(mock.send).not.toHaveBeenCalled();
});
it("rejects expiry during source download before PUT", async () => {
  let time = 1001;
  mock.send.mockRejectedValueOnce(denied(404)).mockImplementationOnce(() => { time = m.expiresAt; return response("original"); });
  const a = createS3EvidenceBackup({ ...options, now: () => time });
  await expect(a.copy(expected)).rejects.toThrow();
  expect(mock.send).toHaveBeenCalledTimes(2);
});
it("purges only enumerated verified versions and confirms absence", async () => {
  mock.send.mockResolvedValueOnce({ Versions: [{ Key: m.backupKey, VersionId: "copy" }] })
    .mockResolvedValueOnce(response()).mockResolvedValueOnce({}).mockResolvedValueOnce({});
  expect(await adapter(m.deleteAt).purge(m)).toBe(1);
  expect(mock.send.mock.calls[2]![0].input).toMatchObject({ Key: m.backupKey, VersionId: "copy" });
});
it("empty purge is retry safe", async () => {
  mock.send.mockResolvedValue({});
  expect(await adapter(m.deleteAt).purge(m)).toBe(0);
});
it.each([{ IsTruncated: true }, { DeleteMarkers: [{ Key: m.backupKey, VersionId: "marker" }] },
  { Versions: [{ Key: "other", VersionId: "v1" }] }, { Versions: [{ Key: m.backupKey, VersionId: "null" }] }])("rejects unsafe inventory %#", async result => {
  mock.send.mockResolvedValueOnce(result);
  await expect(adapter(m.deleteAt).purge(m)).rejects.toThrow();
  expect(mock.send).toHaveBeenCalledTimes(1);
});
it("does not delete any version if later verification fails", async () => {
  mock.send.mockResolvedValueOnce({ Versions: [{ Key: m.backupKey, VersionId: "copy" }, { Key: m.backupKey, VersionId: "other" }] })
    .mockResolvedValueOnce(response()).mockResolvedValueOnce(response("other", { ...m, sourceVersion: "changed" }));
  await expect(adapter(m.deleteAt).purge(m)).rejects.toThrow();
  expect(mock.send.mock.calls.some(c => c[0].kind === "delete")).toBe(false);
});
it("rejects early purge without I/O", async () => {
  await expect(adapter(m.deleteAt - 1).purge(m)).rejects.toThrow();
  expect(mock.send).not.toHaveBeenCalled();
});
it("requires empty post-deletion inventory", async () => {
  mock.send.mockResolvedValueOnce({}).mockResolvedValueOnce({ Versions: [{ Key: m.backupKey, VersionId: "late" }] });
  await expect(adapter(m.deleteAt).purge(m)).rejects.toThrow("backup_purge_incomplete");
});
it("rejects same bucket and alternate regions", () => {
  expect(() => createS3EvidenceBackup({ ...options, backupBucket: options.sourceBucket })).toThrow();
  expect(() => createS3EvidenceBackup({ ...options, region: "other" })).toThrow();
});
