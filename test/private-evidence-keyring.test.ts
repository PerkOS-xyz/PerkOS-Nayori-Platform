import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { describe,it,expect } from "vitest";
import { loadPrivateEvidenceKeyring } from "../src/private-evidence-keyring.js";
describe("operator file keyring",()=>{
  it.each(["valid","permissions","symlink","duplicate-id","duplicate-key","missing-active","short","oversize","relative"])("validates %s without leaking contents",async mode=>{
    const dir=await realpath(await mkdtemp(join(tmpdir(),"nayori-keyring-"))), path=join(dir,"keys.json");
    const secret=randomBytes(32).toString("base64");
    const data={activeKeyId:mode==="missing-active"?"absent":"k1",keys:[{id:"k1",keyBase64:mode==="short"?"YQ==":secret}]};
    if(mode==="duplicate-id") data.keys.push({id:"k1",keyBase64:randomBytes(32).toString("base64")});
    if(mode==="duplicate-key") data.keys.push({id:"k2",keyBase64:secret});
    try {
      await writeFile(path,mode==="oversize"?"x".repeat(8193):JSON.stringify(data),{mode:0o600});
      if(mode==="permissions") await chmod(path,0o644);
      if(mode==="symlink") await symlink(path,join(dir,"link"));
      const target=mode==="symlink"?join(dir,"link"):mode==="relative"?"keys.json":path;
      if(mode!=="valid") await expect(loadPrivateEvidenceKeyring(target)).rejects.toThrow("private_evidence_keyring_invalid");
      else {
        const keyring=await loadPrivateEvidenceKeyring(path), active=await keyring.active();
        expect(active.keyId).toBe("k1"); expect(Buffer.from(active.key).toString("base64")).toBe(secret);
        active.key.fill(0); expect(Buffer.from(await keyring.read("k1")).toString("base64")).toBe(secret);
        await expect(keyring.read("unknown")).rejects.toThrow("private_evidence_key_unavailable");
        expect(JSON.stringify(keyring)).not.toContain(secret);
      }
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
