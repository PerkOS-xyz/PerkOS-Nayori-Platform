import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { createHash,randomBytes } from "node:crypto";
import { describe,it,expect } from "vitest";
import { PostgresPrivateEvidenceStore } from "../src/private-evidence-store.js";
import { PrivateEvidenceMaintenance } from "../src/private-evidence-maintenance.js";
const address="ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", contract=`${address}.sbtc-commerce-v5`;
describe.skipIf(process.env.DATABASE_INTEGRATION!=="true")("operator rotation and expiry with real PostgreSQL",()=>{
  it("rotates atomically without TTL renewal, denies missing keys and purges only scoped expiry",async()=>{
    const schema=`maintenance_${randomBytes(10).toString("hex")}`,admin=new Pool({connectionString:process.env.DATABASE_URL,max:1});
    let pool:Pool|undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,query_timeout:5000,options:`-c search_path=${schema}`});
      await pool.query(await readFile(new URL("../migrations/006_private_evidence.sql",import.meta.url),"utf8"));
      const old=randomBytes(32),fresh=randomBytes(32); let active="old";
      const keys={active:async()=>({keyId:active,key:active==="old"?old:fresh}),read:async(id:string)=>{if(id==="old")return old;if(id==="new")return fresh;throw Error();}};
      const store=new PostgresPrivateEvidenceStore(pool,keys,{maxRecords:100,maxStoredBytes:100000,retentionSeconds:3600});
      const bytes=Buffer.from("rotation-fixture"),context={network:"testnet" as const,contract,jobId:"1",provider:address,mediaType:"text/plain" as const,sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
      // Maintenance test only: authorization policies are tested in HTTP/chain integration separately.
      const receipt=await store.put(context,bytes,async()=>{});
      await store.put({...context,jobId:"2"},bytes,async()=>{});
      active="new";
      const maintenance=new PrivateEvidenceMaintenance(pool,keys,"testnet",[contract],100000);
      expect(await maintenance.rotateBatch(1)).toEqual({rotated:1});
      expect(await maintenance.rotateBatch(100)).toEqual({rotated:1});
      expect(await maintenance.rotateBatch(100)).toEqual({rotated:0});
      expect(await store.get(context,async()=>{})).toEqual(bytes);
      expect((await pool.query("SELECT expires_at FROM private_evidence WHERE job_id=1")).rows[0].expires_at.toISOString()).toBe(receipt.expiresAt);
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence WHERE envelope->>'keyId'='old'")).rows[0].n).toBe(0);
      const oldOnly=new PostgresPrivateEvidenceStore(pool,{active:async()=>({keyId:"old",key:old}),read:async()=>old},{maxRecords:100,maxStoredBytes:100000,retentionSeconds:3600});
      await expect(oldOnly.get(context,async()=>{})).rejects.toThrow();
      // Corruption aborts the entire batch; no partially rotated records are committed.
      active="old";
      await pool.query("UPDATE private_evidence SET envelope=jsonb_set(envelope,'{tag}',to_jsonb(repeat('0',32))) WHERE job_id=2");
      await expect(maintenance.rotateBatch(100)).rejects.toThrow("private_evidence_maintenance_failed");
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence WHERE envelope->>'keyId'='old'")).rows[0].n).toBe(0);
      await pool.query("UPDATE private_evidence SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE job_id=1");
      expect(await maintenance.purgeExpired(100)).toEqual({count:1,executed:false});
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence")).rows[0].n).toBe(2);
      const foreign=new PrivateEvidenceMaintenance(pool,keys,"testnet",[`${address}.other`],100000);
      expect(await foreign.purgeExpired(100,true)).toEqual({count:0,executed:true});
      expect(await maintenance.purgeExpired(1,true)).toEqual({count:1,executed:true});
      expect(await maintenance.purgeExpired(1,true)).toEqual({count:0,executed:true});
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence")).rows[0].n).toBe(1);
      await expect(store.get(context,async()=>{})).rejects.toThrow();
      for(const n of [0,101,-1,1.5]) await expect(maintenance.purgeExpired(n,true)).rejects.toThrow();
    } finally {await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  });
});
