import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createBackupRetention } from "../src/private-evidence-backup-retention.js";
import { validateEvidenceBackupManifest } from "../src/private-evidence-backup-policy.js";

describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")("backup retention PostgreSQL", () => {
  it("reconciles expired pending copies, preserves failed work and isolates scope", async () => {
    const schema = `retention_test_${randomBytes(10).toString("hex")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, query_timeout: 10000, options: `-c search_path=${schema}` });
      for (const file of ["007_private_evidence_objects.sql", "008_private_evidence_purge.sql", "009_private_evidence_backups.sql", "010_private_evidence_backup_scope.sql"])
        await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      const contract = "ST123.contract", now = Date.now();
      const add = async (scope: string | null, expiry: number) => {
        const id = randomUUID();
        await pool!.query("INSERT INTO private_evidence_backups (evidence_id,contract,expected) VALUES ($1,$2,$3)", [id, scope,
          { sourceKey: `private-evidence/testnet/${id}`, sourceVersion: "original", sha256: "a".repeat(64), sizeBytes: 7, mediaType: "text/plain", expiresAt: expiry }]);
        return id;
      };
      const due = await add(contract, now - 8 * 86400000);
      const other = await add("ST456.other", now - 8 * 86400000);
      const unknown = await add(null, now - 8 * 86400000);
      const retained = await add(contract, now - 86400000);
      let fail = true, calls = 0;
      const cleanup = createBackupRetention(pool, [contract], { purge: async input => {
        calls++; const m = validateEvidenceBackupManifest(input);
        expect(m.deleteAt).toBe(m.expiresAt + 7 * 86400000);
        if (fail) throw Error("fixture-partial-s3-failure");
        return 0; // Remaining inventory empty on retry after a partially successful prior deletion.
      } });
      expect(await cleanup(10)).toEqual({ dryRun: true, eligible: 1, removedVersions: 0, removedIntents: 0 });
      expect(calls).toBe(0);
      await expect(cleanup(10, true)).rejects.toThrow("fixture-partial-s3-failure");
      expect((await pool.query("SELECT evidence_id FROM private_evidence_backups WHERE evidence_id=$1", [due])).rowCount).toBe(1);
      fail = false;
      expect(await cleanup(10, true)).toEqual({ dryRun: false, eligible: 1, removedVersions: 0, removedIntents: 1 });
      expect((await pool.query("SELECT evidence_id FROM private_evidence_backups ORDER BY evidence_id")).rows.map(r => r.evidence_id).sort()).toEqual([other, unknown, retained].sort());
      expect((await cleanup(10, true)).eligible).toBe(0);
      await expect(cleanup(11, true)).rejects.toThrow();
      // Never discard an intent whose verified manifest contradicts its original snapshot.
      const mismatch = await add(contract, now - 8 * 86400000);
      const e = (await pool.query("SELECT expected FROM private_evidence_backups WHERE evidence_id=$1", [mismatch])).rows[0].expected;
      await pool.query("UPDATE private_evidence_backups SET manifest=$2,state='verified' WHERE evidence_id=$1", [mismatch,
        { ...e, sha256: "b".repeat(64), schemaVersion: 1, network: "testnet", backupKey: e.sourceKey.replace("private-evidence/", "private-evidence-backup/"),
          backupVersion: "copy", capturedAt: e.expiresAt - 1000, deleteAt: e.expiresAt + 7 * 86400000 }]);
      const before = calls;
      await expect(cleanup(10, true)).rejects.toThrow("backup_retention_snapshot_mismatch");
      expect(calls).toBe(before);
    } finally {
      await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
  });
});
