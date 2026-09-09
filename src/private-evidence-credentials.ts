import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

const schema = z.object({ accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
  secretAccessKey: z.string().min(32).max(128), sessionToken: z.string().min(1).max(4096).optional() }).strict();

/** Explicit local secret file only. No default AWS chain/root login/env fallback in the server. */
export async function loadEvidenceCredentials(path: string) {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const buffer = Buffer.alloc(8193);
  try {
    if (!isAbsolute(path) || await realpath(path) !== path) throw Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192 ||
        ![0, process.getuid?.()].includes(stat.uid)) throw Error();
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw Error();
    return Object.freeze(schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)))));
  } catch { throw Error("private_evidence_credentials_invalid"); }
  finally { buffer.fill(0); await file?.close(); }
}
