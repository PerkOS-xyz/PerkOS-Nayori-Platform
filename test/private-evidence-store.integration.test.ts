import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresPrivateEvidenceStore } from "../src/private-evidence-store.js";
import { authorizeEvidence, type PrivateEvidenceContext, type PrivateEvidenceJob } from "../src/private-evidence-security.js";

const provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const client = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5";
const evaluator = "STBTXHXFXFGMNPXST7A6XQ1WNGC0V6TB6CDDQZB4";
const bytes = Buffer.from("private-integration-fixture");
const ctx: PrivateEvidenceContext = { network: "testnet", contract: `${client}.sbtc-commerce-v5`, jobId: "1", provider,
  mediaType: "text/plain", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const limits = { maxStoredBytes: 100000, maxRecords: 100, retentionSeconds: 3600 };

describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")("private evidence with real PostgreSQL", () => {
  it("persists encrypted bytes, enforces concurrent quotas, immutable retries and role changes", async () => {
    // Isolated schema; never truncate or mutate application tables.
    const schema = `evidence_test_${randomBytes(10).toString("hex")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8,
        connectionTimeoutMillis: 5000, query_timeout: 10000, options: `-c search_path=${schema}` });
      await pool.query(await readFile(new URL("../migrations/006_private_evidence.sql", import.meta.url), "utf8"));
      const key = randomBytes(32), key2 = randomBytes(32);
      let activeId = "key1";
      const keys = { active: async () => ({ keyId: activeId, key: activeId === "key1" ? key : key2 }),
        read: async (id: string) => { if (id === "key1") return key; if (id === "key2") return key2; throw Error("unknown key"); } };
      let job: PrivateEvidenceJob = { network: "testnet", contract: ctx.contract, jobId: "1", client, provider, evaluator, status: 1, escrow: 1000n };
      const authorize = (walletAddress: string, scope: "evidence:read" | "evidence:write", context = ctx) => async () => {
        await authorizeEvidence({ identity: { walletAddress, clientId: "fixture", merchantId: "fixture" }, scope,
          context, network: "testnet", allowedContracts: [ctx.contract], readJob: async () => job });
      };
      let store = new PostgresPrivateEvidenceStore(pool, keys, limits);
      const receipts = await Promise.all(Array.from({ length: 8 }, () => store.put(ctx, bytes, authorize(provider, "evidence:write"))));
      expect(receipts.filter(r => r.created)).toHaveLength(1);
      expect(new Set(receipts.map(r => r.expiresAt)).size).toBe(1);
      const raw = await pool.query("SELECT * FROM private_evidence");
      expect(raw.rows).toHaveLength(1); expect(JSON.stringify(raw.rows)).not.toContain(bytes.toString());
      // New process/pool-equivalent service instance reads durable data and old key after active key change.
      activeId = "key2"; store = new PostgresPrivateEvidenceStore(pool, keys, limits);
      expect(await store.get(ctx, authorize(client, "evidence:read"))).toEqual(bytes);
      await expect(store.get(ctx, authorize(evaluator, "evidence:read"))).rejects.toThrow();
      job = { ...job, status: 2 };
      expect(await store.get(ctx, authorize(evaluator, "evidence:read"))).toEqual(bytes);
      await expect(store.put(ctx, bytes, authorize(provider, "evidence:write"))).rejects.toThrow();
      // Independent jobs still share global caps. No authorization-free SQL access.
      job = { ...job, jobId: "2", status: 1 };
      const second = { ...ctx, jobId: "2" };
      const capped = new PostgresPrivateEvidenceStore(pool, keys, { ...limits, maxRecords: 1 });
      await expect(capped.put(second, bytes, authorize(provider, "evidence:write", second))).rejects.toThrow();
      const byteCapped = new PostgresPrivateEvidenceStore(pool, keys, { ...limits, maxStoredBytes: 1 });
      await expect(byteCapped.put(second, bytes, authorize(provider, "evidence:write", second))).rejects.toThrow();
      const largeA = Buffer.alloc(8192, "a"), largeB = Buffer.alloc(8192, "b");
      const largeContext = (value: Buffer) => ({ ...second, sizeBytes: value.length, sha256: createHash("sha256").update(value).digest("hex") });
      const a = largeContext(largeA), b = largeContext(largeB);
      await store.put(a, largeA, authorize(provider, "evidence:write", a));
      await expect(store.put(b, largeB, authorize(provider, "evidence:write", b))).rejects.toThrow();
      // Unknown retired key and deletion of an identity deny access without leaking data.
      const missingKey = new PostgresPrivateEvidenceStore(pool, { ...keys, read: async () => { throw Error("MISSING KEY"); } }, limits);
      await expect(missingKey.get(a, authorize(client, "evidence:read", a))).rejects.toThrow("private_evidence_access_denied");
      let checks = 0;
      await expect(store.get(a, async () => { if (++checks > 1) throw Error("revoked"); })).rejects.toThrow();
      expect(checks).toBe(2);
      job = { ...job, status: 1, jobId: "1" };
      const uploads = Array.from({ length: 8 }, (_, i) => {
        const value = Buffer.from(`additional-${i}`);
        const context = { ...ctx, sha256: createHash("sha256").update(value).digest("hex"), sizeBytes: value.length };
        return store.put(context, value, authorize(provider, "evidence:write", context));
      });
      const outcomes = await Promise.allSettled(uploads);
      expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(4);
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence WHERE job_id=1")).rows[0].n).toBe(5);
      job = { ...job, provider: evaluator, evaluator: provider };
      await expect(store.get(ctx, authorize(provider, "evidence:read"))).rejects.toThrow();
      job = { ...job, provider, evaluator };
      await pool.query("UPDATE private_evidence SET envelope=jsonb_set(envelope,'{tag}',to_jsonb(repeat('0',32))) WHERE sha256=$1", [ctx.sha256]);
      await expect(store.get(ctx, authorize(client, "evidence:read"))).rejects.toThrow();
      // Expired bytes remain counted; expiry is denial, not a claim of physical deletion.
      await pool.query("UPDATE private_evidence SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day'");
      await expect(store.get(ctx, authorize(client, "evidence:read"))).rejects.toThrow();
      await expect(store.put(ctx, bytes, authorize(provider, "evidence:write"))).rejects.toThrow();
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
