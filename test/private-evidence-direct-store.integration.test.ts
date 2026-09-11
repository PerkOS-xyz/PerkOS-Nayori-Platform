import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDirectEvidenceMetadata } from "../src/private-evidence-direct-store.js";
import type { DirectEvidenceRecord } from "../src/private-evidence-direct.js";
import { createEvidenceRetentionCleanup } from "../src/private-evidence-cleanup.js";

describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")("direct metadata PostgreSQL integration", () => {
  it("atomically caps concurrent reservations, pins first version and stores no file bytes", async () => {
    const schema = `direct_test_${randomBytes(10).toString("hex")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000,
        query_timeout: 10000, options: `-c search_path=${schema}` });
      await pool.query(await readFile(new URL("../migrations/007_private_evidence_objects.sql", import.meta.url), "utf8"));
      await pool.query(await readFile(new URL("../migrations/008_private_evidence_purge.sql", import.meta.url), "utf8"));
      const store = new PostgresDirectEvidenceMetadata(pool), now = Date.now();
      const make = (): DirectEvidenceRecord => {
        const id = randomUUID();
        return { id, key: `private-evidence/testnet/${id}`, object: null, uploadExpiresAt: now + 300000, expiresAt: now + 3600000,
          context: { network: "testnet", contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
            jobId: "1", provider: "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9", sha256: "a".repeat(64), mediaType: "text/plain", sizeBytes: 5 } };
      };
      const records = Array.from({ length: 10 }, make);
      const results = await Promise.allSettled(records.map(r => store.reserve(r)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(5);
      const saved = records[results.findIndex(r => r.status === "fulfilled")]!;
      const object = { key: saved.key, versionId: "one", checksum: Buffer.from(saved.context.sha256, "hex").toString("base64"), size: 5, mediaType: "text/plain" };
      const finalized = await Promise.all([store.finalize(saved.id, object), store.finalize(saved.id, { ...object, versionId: "two" })]);
      expect(new Set(finalized.map(r => r.object?.versionId)).size).toBe(1);
      expect((await store.find(saved.id))?.expiresAt).toBe(saved.expiresAt);
      await expect(store.finalize(saved.id, { ...object, key: "wrong" })).rejects.toThrow();
      await pool.query("UPDATE private_evidence_objects SET expires_at=now()-interval '1 second', upload_expires_at=now()-interval '2 seconds' WHERE id=$1", [saved.id]);
      await expect(store.finalize(saved.id, object)).rejects.toThrow();
      const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='private_evidence_objects'", [schema])).rows.map(r => r.column_name);
      expect(columns).not.toEqual(expect.arrayContaining(["ciphertext"]));
      expect(columns).not.toContain("content"); expect(columns).not.toContain("signed_url");
      const removed: string[] = [];
      let fail = true;
      const cleanup = createEvidenceRetentionCleanup(pool, { removeExactKey: async key => {
        if (fail) throw Error("fixture_s3_failure"); removed.push(key); return 2;
      } }, [saved.context.contract]);
      expect(await cleanup(10)).toEqual({ dryRun: true, eligible: 1, deletedVersions: 0, pruned: 0 });
      expect(removed).toHaveLength(0);
      await expect(cleanup(10, true)).rejects.toThrow("fixture_s3_failure");
      expect(await store.find(saved.id)).not.toBeNull();
      fail = false;
      expect(await cleanup(10, true)).toEqual({ dryRun: false, eligible: 1, deletedVersions: 2, pruned: 0 });
      expect(removed).toEqual([saved.key]); expect(await store.find(saved.id)).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS count FROM private_evidence_objects WHERE purged_at IS NULL")).rows[0].count).toBe(4);
      await pool.query("UPDATE private_evidence_objects SET expires_at=now()-interval '38 days', upload_expires_at=now()-interval '39 days' WHERE id=$1", [saved.id]);
      expect((await cleanup(10, true)).pruned).toBe(1);
      expect((await pool.query("SELECT id FROM private_evidence_objects WHERE id=$1", [saved.id])).rowCount).toBe(0);
    } finally {
      await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
  });
});
