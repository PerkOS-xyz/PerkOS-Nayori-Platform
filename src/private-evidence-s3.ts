/** Inactive S3 adapter. Bucket/IAM/versioning must pass deployment gates before wiring. */
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PrivateEvidenceDenied, validateEvidenceContext, type PrivateEvidenceContext } from "./private-evidence-security.js";

export interface EvidenceObject {
  key: string; versionId: string; checksum: string; size: number; mediaType: string;
}
export interface EvidenceObjects {
  upload(key: string, context: PrivateEvidenceContext, expires: number): Promise<{ url: string; fields: Record<string, string> }>;
  verify(key: string, context: PrivateEvidenceContext): Promise<EvidenceObject>;
  download(object: EvidenceObject, expires: number): Promise<string>;
}
const deny = () => new PrivateEvidenceDenied();
function validateKey(key: string) {
  if (!/^private-evidence\/(testnet|mainnet)\/[0-9a-f-]{36}$/.test(key)) throw deny();
}
function ttl(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw deny();
}

/** Region/bucket are operator configuration. No caller endpoints, bucket names or credentials. */
export function createS3EvidenceObjects(options: { bucket: string; region: string; accountId: string }): EvidenceObjects {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !/^[a-z]{2}-[a-z]+-\d$/.test(options.region) || !/^\d{12}$/.test(options.accountId)) throw deny();
  const client = new S3Client({ region: options.region, maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
    // Do not inherit an endpoint override that could receive signed requests/credentials.
    endpoint: `https://s3.${options.region}.amazonaws.com` });
  return {
    async upload(key, input, expires) {
      validateKey(key); ttl(expires);
      const c = validateEvidenceContext(input);
      const fields = { "Content-Type": c.mediaType, "x-amz-checksum-algorithm": "SHA256",
        "x-amz-checksum-sha256": Buffer.from(c.sha256, "hex").toString("base64"),
        "x-amz-server-side-encryption": "AES256", "success_action_status": "201" };
      return createPresignedPost(client, { Bucket: options.bucket, Key: key, Expires: expires,
        Fields: fields, Conditions: [["content-length-range", c.sizeBytes, c.sizeBytes],
          ...Object.entries(fields).map(([name, value]) => ({ [name]: value }))] });
    },
    async verify(key, input) {
      validateKey(key);
      const c = validateEvidenceContext(input);
      const h = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: key,
        ExpectedBucketOwner: options.accountId, ChecksumMode: "ENABLED" }), { abortSignal: AbortSignal.timeout(5000) });
      const checksum = Buffer.from(c.sha256, "hex").toString("base64");
      if (!h.VersionId || h.VersionId === "null" || h.DeleteMarker || h.ContentLength !== c.sizeBytes ||
          h.ContentType !== c.mediaType || h.ChecksumSHA256 !== checksum || h.ServerSideEncryption !== "AES256") throw deny();
      return { key, versionId: h.VersionId, checksum, size: c.sizeBytes, mediaType: c.mediaType };
    },
    async download(object, expires) {
      validateKey(object.key); ttl(expires);
      if (!object.versionId || object.versionId === "null") throw deny();
      return getSignedUrl(client, new GetObjectCommand({ Bucket: options.bucket, Key: object.key,
        VersionId: object.versionId, ExpectedBucketOwner: options.accountId,
        ResponseCacheControl: "no-store", ResponseContentDisposition: 'attachment; filename="evidence"',
        ResponseContentType: "application/octet-stream" }), { expiresIn: expires });
    },
  };
}
