import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPrivateEvidenceHttp } from "../src/private-evidence-http.js";
import { PostgresPrivateEvidenceStore } from "../src/private-evidence-store.js";

const client="ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5", provider="ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const evaluator="STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4", contract=`${client}.sbtc-commerce-v5`;
describe.skipIf(process.env.DATABASE_INTEGRATION!=="true")("private HTTP socket and PostgreSQL (fixture issuer/chain)",()=>{
  it("roundtrips ciphertext-backed private data, retries, restarts, revocation and tampering",async()=>{
    const schema=`http_evidence_${randomBytes(10).toString("hex")}`;
    const admin=new Pool({connectionString:process.env.DATABASE_URL,max:1});
    let pool: Pool|undefined; let server: ReturnType<typeof serve>|undefined;
    const stop=async()=>{ if(server){ const instance=server; server=undefined; await new Promise<void>((resolve,reject)=>instance.close(error=>error?reject(error):resolve())); } };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool=new Pool({connectionString:process.env.DATABASE_URL,max:8,connectionTimeoutMillis:5000,query_timeout:5000,options:`-c search_path=${schema}`});
      await pool.query(await readFile(new URL("../migrations/006_private_evidence.sql",import.meta.url),"utf8"));
      const pair=await generateKeyPair("EdDSA"), key=randomBytes(32), issuer="https://issuer.fixture.invalid", audience="https://app.fixture.invalid";
      const keys=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:"fixture"}]});
      const identity=new Map<string,string>();
      for(const wallet of [client,provider,evaluator]){
        identity.set(wallet,await new SignJWT({client_id:`ny_oc_${"a".repeat(24)}`,wallet_address:wallet,scope:"evidence:read evidence:write"})
          .setProtectedHeader({alg:"EdDSA",typ:"at+jwt",kid:"fixture"}).setIssuer(issuer).setAudience(audience).setSubject("fixture").setIssuedAt().setExpirationTime("10m").sign(pair.privateKey));
      }
      let active=true, state=1;
      const start=async()=>{
        const store=new PostgresPrivateEvidenceStore(pool!,{active:async()=>({keyId:"fixture",key}),read:async()=>key},{maxRecords:100,maxStoredBytes:100000,retentionSeconds:3600});
        const app=createPrivateEvidenceHttp({network:"testnet",allowedContracts:[contract],issuer,audience,keys,store,
          isMerchantActive:async()=>active,readJob:async(_contract,jobId)=>jobId==="1"?{network:"testnet",contract,jobId,client,provider,evaluator,status:state,escrow:1000n}:null,
          issuerFetcher:async(_url,init)=>{
            const headers=new Headers(init?.headers),token=headers.get("authorization")?.slice(7);
            const wallet=[...identity.entries()].find(([,value])=>value===token)?.[0];
            return new Response(JSON.stringify({active:true,clientId:`ny_oc_${"a".repeat(24)}`,walletAddress:wallet,merchantId:"fixture",scope:headers.get("x-nayori-evidence-scope"),expiresAt:Math.floor(Date.now()/1000)+600}),{headers:{"content-type":"application/json"}});
          }});
        // Real loopback HTTP only for disposable fixtures; public runtime requires TLS proxy.
        return await new Promise<string>(resolve=>{server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0},info=>resolve(`http://127.0.0.1:${info.port}`));});
      };
      let origin=await start();
      const content="PRIVATE-HTTP-DATABASE-FIXTURE",bytes=Buffer.from(content);
      const context={network:"testnet",contract,jobId:"1",provider,mediaType:"text/plain",sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
      const request=async(wallet:string,operation:string,body:object)=>{
        const response=await fetch(`${origin}/v1/private-evidence/${operation}`,{method:"POST",headers:{authorization:`Bearer ${identity.get(wallet)}`,"content-type":"application/json"},body:JSON.stringify(body)});
        return {status:response.status,text:await response.text(),cache:response.headers.get("cache-control")};
      };
      expect((await request(client,"write",{context,content})).status).toBe(403);
      const writes=await Promise.all(Array.from({length:4},()=>request(provider,"write",{context,content})));
      expect(writes.filter(r=>r.status===201)).toHaveLength(1); expect(writes.filter(r=>r.status===200)).toHaveLength(3);
      expect(new Set(writes.map(r=>JSON.parse(r.text).expiresAt)).size).toBe(1);
      expect(JSON.stringify((await pool.query("SELECT * FROM private_evidence")).rows)).not.toContain(content);
      expect(await request(client,"read",{context})).toEqual({status:200,text:content,cache:"no-store"});
      expect((await request(evaluator,"read",{context})).status).toBe(403);
      state=2; expect((await request(evaluator,"read",{context})).text).toBe(content);
      expect((await request(provider,"write",{context,content})).status).toBe(403);
      await stop(); origin=await start(); // New HTTP/store instances, same durable ciphertext.
      expect((await request(client,"read",{context})).text).toBe(content);
      active=false; expect((await request(client,"read",{context})).status).toBe(403); active=true;
      expect((await request(client,"read",{context:{...context,jobId:"2"}})).status).toBe(403);
      await pool.query("UPDATE private_evidence SET envelope=jsonb_set(envelope,'{tag}',to_jsonb(repeat('0',32)))");
      const corrupt=await request(client,"read",{context}); expect(corrupt.status).toBe(403); expect(corrupt.text).not.toContain(content);
    } finally {
      await stop(); await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
  },30000);
});
