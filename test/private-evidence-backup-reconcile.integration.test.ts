import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPendingBackupReconciliation } from "../src/private-evidence-backup-reconcile.js";
import type { EvidenceBackupManifest } from "../src/private-evidence-backup-policy.js";

describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")("pending backup reconciliation PostgreSQL", () => {
  it("reserves before copy, survives ambiguous write, excludes verified work and serializes batches", async () => {
    const schema = `pending_test_${randomBytes(10).toString("hex")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, query_timeout: 10000, options: `-c search_path=${schema}` });
      for (const file of ["007_private_evidence_objects.sql", "008_private_evidence_purge.sql", "009_private_evidence_backups.sql", "010_private_evidence_backup_scope.sql"])
        await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      const contract = "ST123.contract", bytes = Buffer.from("fixture"), hash = createHash("sha256").update(bytes).digest("hex");
      const add = async (scope: string, version: string | null = "original") => {
        const id = randomUUID(), time = Date.now();
        await pool!.query(`INSERT INTO private_evidence_objects
          (id,network,contract,job_id,provider,sha256,media_type,size_bytes,object_key,upload_expires_at,expires_at,version_id)
          VALUES ($1,'testnet',$2,'1','fixture',$3,'text/plain',7,$4,$5,$6,$7)`,
        [id, scope, hash, `private-evidence/testnet/${id}`, new Date(time+300000), new Date(time+3600000), version]);
        return id;
      };
      const id = await add(contract); await add("ST456.other"); await add(contract, null);
      const copies = new Map<string, EvidenceBackupManifest>(); let fail = true, writes = 0;
      const run = createPendingBackupReconciliation(pool, [contract], {
        copy: async e => {
          expect((await pool!.query("SELECT state FROM private_evidence_backups WHERE evidence_id=$1", [id])).rows[0].state).toBe("pending");
          if (!copies.has(e.sourceKey)) { copies.set(e.sourceKey, { ...e, schemaVersion: 1, network: "testnet", backupKey: e.sourceKey.replace("private-evidence/", "private-evidence-backup/"),
            backupVersion: "copy", capturedAt: Date.now(), deleteAt: e.expiresAt+7*86400000 }); writes++; }
          if (fail) { fail=false; throw Error("fixture-response-lost-after-copy"); }
          return copies.get(e.sourceKey)!;
        }, readBackup: async () => bytes,
      });
      expect(await run(10)).toMatchObject({ eligible: 1, verified: 0, failed: 0 });
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence_backups")).rows[0].n).toBe(0);
      expect(await run(10, true)).toMatchObject({ eligible: 1, verified: 0, failed: 1 });
      expect(await run(10, true)).toMatchObject({ eligible: 1, verified: 1, failed: 0 }); expect(writes).toBe(1);
      expect((await run(10, true)).eligible).toBe(0);
      const blocker = await pool.connect();
      try {
        await blocker.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':nayori-backup-reconcile-v1'))");
        expect((await run(10, true)).busy).toBe(true);
      } finally { await blocker.query("SELECT pg_advisory_unlock_all()"); blocker.release(); }
      expect((await run(10)).busy).toBe(false);
      await expect(run(11, true)).rejects.toThrow();
    } finally { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
});
