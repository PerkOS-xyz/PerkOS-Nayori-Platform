import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { EvidenceKeyring } from "./private-evidence-store.js";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const schema = z.object({ activeKeyId: id, keys: z.array(z.object({ id, keyBase64: z.string().max(44) }).strict()).min(1).max(8) }).strict();

/** Load once per process. Operator-provided file only, outside repository/database/backups.
 * Rotation requires coordinated writer restarts; never remove a key merely because it is inactive.
 */
export async function loadPrivateEvidenceKeyring(path: string): Promise<EvidenceKeyring> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(path) || await realpath(path) !== path) throw Error();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192 ||
        ![0, process.getuid?.()].includes(stat.uid)) throw Error();
    const buffer = Buffer.alloc(8193);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length-length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 8192) throw Error();
    const parsed = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0,length))));
    buffer.fill(0);
    const keys = new Map<string, Buffer>(), materials = new Set<string>();
    for (const entry of parsed.keys) {
      const key = Buffer.from(entry.keyBase64,"base64");
      if (key.length !== 32 || key.toString("base64") !== entry.keyBase64 || keys.has(entry.id) || materials.has(entry.keyBase64)) throw Error();
      keys.set(entry.id,key); materials.add(entry.keyBase64);
    }
    if (!keys.has(parsed.activeKeyId)) throw Error();
    const read = async (keyId: string) => {
      const key = keys.get(keyId); if (!key) throw Error("private_evidence_key_unavailable");
      return Buffer.from(key);
    };
    return Object.freeze({ active: async () => ({ keyId: parsed.activeKeyId, key: await read(parsed.activeKeyId) }), read });
  } catch { throw Error("private_evidence_keyring_invalid"); }
  finally { await file?.close(); }
}
