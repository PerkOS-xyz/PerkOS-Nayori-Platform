import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createEvidenceBackupLedger } from "../src/private-evidence-backup-ledger.js";
import { recoverPrivateEvidence } from "../src/private-evidence-recover.js";

describe.skipIf(process.env.DATABASE_INTEGRATION !== "true")("backup ledger PostgreSQL", () => {
  it("durably reserves, verifies, atomically restores and rejects unsafe retries", async () => {
    const schema = `backup_test_${randomBytes(10).toString("hex")}`;
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4,
        query_timeout: 10000, options: `-c search_path=${schema}` });
      for (const file of ["007_private_evidence_objects.sql", "008_private_evidence_purge.sql", "009_private_evidence_backups.sql"])
        await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
      const contract = "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5";
      const ledger = createEvidenceBackupLedger(pool, [contract]);
      const bytes = Buffer.from("fixture"), hash = createHash("sha256").update(bytes).digest("hex");
      const id = randomUUID(), now = Date.now(), expiry = now + 3600000;
      await pool.query(`INSERT INTO private_evidence_objects
        (id,network,contract,job_id,provider,sha256,media_type,size_bytes,object_key,upload_expires_at,expires_at,version_id)
        VALUES ($1,'testnet',$2,'1','fixture-provider',$3,'text/plain',7,$4,$5,$6,'original')`,
      [id, contract, hash, `private-evidence/testnet/${id}`, new Date(now + 300000), new Date(expiry)]);
      const [a, b] = await Promise.all([ledger.reserve(id), ledger.reserve(id)]);
      expect(a).toEqual(b);
      expect((await pool.query("SELECT state FROM private_evidence_backups")).rows).toEqual([{ state: "pending" }]);
      const manifest = { ...a, schemaVersion: 1, network: "testnet", backupKey: `private-evidence-backup/testnet/${id}`,
        backupVersion: "copy", capturedAt: now, deleteAt: expiry + 7 * 86400000 };
      await expect(ledger.verify(id, manifest, Buffer.from("changed"))).rejects.toThrow();
      expect((await pool.query("SELECT state FROM private_evidence_backups")).rows[0].state).toBe("pending");
      await ledger.verify(id, manifest, bytes);
      await ledger.verify(id, manifest, bytes);
      expect((await ledger.loadRecovery(id)).manifest).toEqual(manifest);
      await expect(ledger.verify(id, { ...manifest, backupVersion: "other" }, bytes)).rejects.toThrow();
      await expect(ledger.commitRestore(id, "original", bytes)).rejects.toThrow();
      await expect(ledger.commitRestore(id, "new", Buffer.from("tamper!"))).rejects.toThrow();
      // Concurrent retry of the same verified readback must not produce competing mappings.
      const fakeS3 = { restore: async () => ({ versionId: "new", bytes }) };
      await Promise.all([recoverPrivateEvidence(id, ledger, fakeS3), recoverPrivateEvidence(id, ledger, fakeS3)]);
      expect((await recoverPrivateEvidence(id, ledger, fakeS3)).versionId).toBe("new");
      const row = (await pool.query("SELECT version_id,expires_at FROM private_evidence_objects WHERE id=$1", [id])).rows[0];
      expect(row.version_id).toBe("new"); expect(new Date(row.expires_at).getTime()).toBe(expiry);
      await expect(ledger.commitRestore(id, "different-new", bytes)).rejects.toThrow();
      await expect(ledger.reserve(id)).rejects.toThrow();
      await pool.query("UPDATE private_evidence_objects SET purged_at=clock_timestamp() WHERE id=$1", [id]);
      await expect(ledger.commitRestore(id, "new", bytes)).rejects.toThrow();
      await pool.query("UPDATE private_evidence_objects SET purged_at=NULL, upload_expires_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
      await expect(ledger.commitRestore(id, "new", bytes)).rejects.toThrow();
      // Source retention cleanup cannot cascade away the pending/verified backup inventory.
      await pool.query("DELETE FROM private_evidence_objects WHERE id=$1", [id]);
      expect((await pool.query("SELECT count(*)::int AS n FROM private_evidence_backups")).rows[0].n).toBe(1);
      await expect(ledger.reserve(id)).rejects.toThrow();
    } finally {
      await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
  });
});
