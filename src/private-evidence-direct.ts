import { randomUUID } from "node:crypto";
import { PrivateEvidenceDenied, validateEvidenceContext, type PrivateEvidenceContext } from "./private-evidence-security.js";
import type { EvidenceObject, EvidenceObjects } from "./private-evidence-s3.js";

export interface DirectEvidenceRecord {
  id: string; context: PrivateEvidenceContext; key: string; uploadExpiresAt: number;
  expiresAt: number; object: EvidenceObject | null;
}
/** Must atomically reserve quotas including pending records; never accept client metadata as rows. */
export interface DirectEvidenceMetadata {
  reserve(record: DirectEvidenceRecord): Promise<void>;
  find(id: string): Promise<DirectEvidenceRecord | null>;
  /** Compare-and-set: first version wins, retries must return the original stored record. */
  finalize(id: string, object: EvidenceObject): Promise<DirectEvidenceRecord>;
}
export type DirectEvidenceAuthorize = (context: PrivateEvidenceContext, scope: "evidence:write" | "evidence:read") => Promise<void>;
const deny = () => new PrivateEvidenceDenied();

/** No route registration. Caller must authenticate before parsing requests AND in authorize. */
export function createDirectEvidenceService(options: {
  metadata: DirectEvidenceMetadata; objects: EvidenceObjects; retentionSeconds: number; now?: () => number;
}) {
  if (!Number.isInteger(options.retentionSeconds) || options.retentionSeconds < 600 || options.retentionSeconds > 31536000) throw deny();
  const now = options.now ?? Date.now;
  async function record(id: string, authorize: DirectEvidenceAuthorize, scope: "evidence:read" | "evidence:write") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw deny();
    const r = await options.metadata.find(id);
    if (!r || r.expiresAt <= now()) throw deny();
    await authorize(r.context, scope);
    return r;
  }
  return {
    async prepare(input: unknown, authorize: DirectEvidenceAuthorize) {
      const context = Object.freeze(validateEvidenceContext(input));
      await authorize(context, "evidence:write");
      const id = randomUUID(), started = now();
      const r: DirectEvidenceRecord = { id, context, key: `private-evidence/${context.network}/${id}`,
        uploadExpiresAt: started + 300000, expiresAt: started + options.retentionSeconds * 1000, object: null };
      await options.metadata.reserve(r);
      const remaining = Math.min(300, Math.floor((r.uploadExpiresAt - now()) / 1000));
      if (remaining < 1) throw deny();
      const post = await options.objects.upload(r.key, context, remaining);
      await authorize(context, "evidence:write");
      if (r.uploadExpiresAt <= now()) throw deny();
      return { id, upload: post, uploadExpiresAt: r.uploadExpiresAt, expiresAt: r.expiresAt };
    },
    async complete(id: string, authorize: DirectEvidenceAuthorize) {
      const r = await record(id, authorize, "evidence:write");
      if (!r.object) {
        if (r.uploadExpiresAt <= now()) throw deny();
        const object = await options.objects.verify(r.key, r.context);
        if (object.key !== r.key || object.size !== r.context.sizeBytes || object.mediaType !== r.context.mediaType ||
            object.checksum !== Buffer.from(r.context.sha256, "hex").toString("base64") || !object.versionId || object.versionId === "null") throw deny();
        await authorize(r.context, "evidence:write");
        if (r.uploadExpiresAt <= now() || r.expiresAt <= now()) throw deny();
        await options.metadata.finalize(id, object);
      }
      await authorize(r.context, "evidence:write");
      if (r.expiresAt <= now()) throw deny();
      return { id: r.id, sha256: r.context.sha256, expiresAt: r.expiresAt };
    },
    async download(id: string, authorize: DirectEvidenceAuthorize) {
      const r = await record(id, authorize, "evidence:read");
      if (!r.object) throw deny();
      const seconds = Math.min(60, Math.floor((r.expiresAt - now()) / 1000));
      if (seconds < 1) throw deny();
      const url = await options.objects.download(r.object, seconds);
      await authorize(r.context, "evidence:read");
      if (r.expiresAt <= now()) throw deny();
      return { url, expiresIn: seconds };
    },
  };
}
