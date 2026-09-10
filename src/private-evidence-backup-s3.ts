import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { evidenceBackupPhase, validateEvidenceBackupManifest, verifyEvidenceRecovery, type EvidenceBackupManifest } from "./private-evidence-backup-policy.js";
import { EVIDENCE_BACKUP_GRACE_SECONDS } from "./private-evidence-policy.js";

export type EvidenceBackupSource = Pick<EvidenceBackupManifest,
  "sourceKey" | "sourceVersion" | "sha256" | "sizeBytes" | "mediaType" | "expiresAt">;
type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** Operator-only adapter. No routes, scheduler or default credential chain. Separate source/backup
 * identities; source needs only exact-version reads. Backup writing uses conditional creation.
 * The caller must persist the verified manifest durably and reconcile orphan copies before enabling uploads.
 */
export function createS3EvidenceBackup(options: { sourceBucket: string; backupBucket: string;
  accountId: string; region: string; sourceCredentials: Credentials; backupCredentials: Credentials;
  now?: () => number }) {
  const bucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!bucket.test(options.sourceBucket) || !bucket.test(options.backupBucket) ||
      options.sourceBucket === options.backupBucket || options.region !== "us-east-1" ||
      !/^\d{12}$/.test(options.accountId)) throw Error("invalid_backup_config");
  const config = { region: options.region, endpoint: "https://s3.us-east-1.amazonaws.com", maxAttempts: 1,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } };
  const source = new S3Client({ ...config, credentials: { ...options.sourceCredentials } });
  const backup = new S3Client({ ...config, credentials: { ...options.backupCredentials } });
  const now = options.now ?? Date.now;
  const owner = { ExpectedBucketOwner: options.accountId };
  const signal = () => ({ abortSignal: AbortSignal.timeout(5000) });
  const missing = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
  const conflict = (e: unknown) => [409, 412].includes((e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? 0);
  async function read(client: S3Client, Bucket: string, Key: string, VersionId?: string) {
    const r = await client.send(new GetObjectCommand({ Bucket, Key, VersionId, ...owner }), signal());
    if (!r.Body) throw Error("invalid_backup_object");
    // Bound the stream, not just the untrusted Content-Length header.
    const chunks: Buffer[] = []; let size = 0;
    try {
      if (!r.VersionId || r.VersionId === "null" || r.DeleteMarker || r.ServerSideEncryption !== "AES256" ||
          !r.ContentLength || r.ContentLength > 8192 || (VersionId && r.VersionId !== VersionId)) throw Error("invalid_backup_object");
      for await (const chunk of r.Body as AsyncIterable<Uint8Array>) {
        const b = Buffer.from(chunk); size += b.length;
        if (size > 8192) throw Error("backup_object_too_large");
        chunks.push(b);
      }
      if (size !== r.ContentLength) throw Error("invalid_backup_length");
      return { response: r, bytes: Buffer.concat(chunks) };
    } finally { (r.Body as { destroy?: () => void }).destroy?.(); }
  }
  function decode(r: Awaited<ReturnType<typeof read>>) {
    let parsed: unknown;
    try { parsed = JSON.parse(r.response.Metadata?.manifest ?? ""); } catch { throw Error("invalid_backup_manifest"); }
    const m = validateEvidenceBackupManifest({ ...(parsed as object), backupVersion: r.response.VersionId });
    if (r.response.ContentType !== m.mediaType || r.bytes.length !== m.sizeBytes ||
        createHash("sha256").update(r.bytes).digest("hex") !== m.sha256) throw Error("backup_integrity_failed");
    return m;
  }
  const list = (key: string) => backup.send(new ListObjectVersionsCommand({ Bucket: options.backupBucket,
    Prefix: key, MaxKeys: 1000, ...owner }), signal());
  return {
    async copy(expected: EvidenceBackupSource): Promise<EvidenceBackupManifest> {
      const draft = validateEvidenceBackupManifest({ ...expected, schemaVersion: 1, network: "testnet",
        backupKey: expected.sourceKey.replace("private-evidence/", "private-evidence-backup/"),
        backupVersion: "pending", capturedAt: now(), deleteAt: expected.expiresAt + EVIDENCE_BACKUP_GRACE_SECONDS * 1000 });
      const verifyExisting = async () => {
        const r = await read(backup, options.backupBucket, draft.backupKey);
        const m = decode(r);
        if (m.backupKey !== draft.backupKey) throw Error("backup_key_mismatch");
        return verifyEvidenceRecovery(m, r.bytes, expected, now());
      };
      try { return await verifyExisting(); } catch (e) { if (!missing(e)) throw e; }
      const r = await read(source, options.sourceBucket, expected.sourceKey, expected.sourceVersion);
      if (r.response.ContentType !== expected.mediaType) throw Error("backup_media_type_mismatch");
      verifyEvidenceRecovery(draft, r.bytes, expected, now());
      try {
        await backup.send(new PutObjectCommand({ Bucket: options.backupBucket, Key: draft.backupKey,
          Body: r.bytes, ContentType: draft.mediaType, ServerSideEncryption: "AES256", IfNoneMatch: "*",
          ChecksumSHA256: Buffer.from(draft.sha256, "hex").toString("base64"),
          Metadata: { manifest: JSON.stringify(draft) }, ...owner }), signal());
      } catch (e) { if (!conflict(e)) throw e; }
      // An ambiguous PUT failure is not retried here. A later invocation discovers the existing copy.
      return verifyExisting();
    },
    async purge(input: unknown): Promise<number> {
      const m = validateEvidenceBackupManifest(input);
      if (evidenceBackupPhase(m, now()) !== "purge-due") throw Error("backup_not_expired");
      const inventory = await list(m.backupKey);
      const versions = inventory.Versions ?? [];
      if (inventory.IsTruncated || inventory.DeleteMarkers?.length || versions.length > 100 ||
          versions.some(v => v.Key !== m.backupKey || !v.VersionId || v.VersionId === "null")) throw Error("unsafe_backup_inventory");
      // Validate ALL versions before deleting ANY. Conflicting expiry/hash means operator review.
      for (const v of versions) {
        const stored = decode(await read(backup, options.backupBucket, m.backupKey, v.VersionId));
        for (const field of ["sourceKey", "sourceVersion", "backupKey", "sha256", "sizeBytes", "mediaType", "expiresAt", "deleteAt"] as const) {
          if (stored[field] !== m[field]) throw Error("backup_inventory_mismatch");
        }
        if (evidenceBackupPhase(stored, now()) !== "purge-due") throw Error("backup_not_expired");
      }
      for (const v of versions) await backup.send(new DeleteObjectCommand({ Bucket: options.backupBucket,
        Key: m.backupKey, VersionId: v.VersionId, ...owner }), signal());
      const remaining = await list(m.backupKey);
      if (remaining.IsTruncated || remaining.Versions?.length || remaining.DeleteMarkers?.length) throw Error("backup_purge_incomplete");
      return versions.length;
    },
    close() { source.destroy(); backup.destroy(); },
  };
}
