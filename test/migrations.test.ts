import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadMigrationFiles } from "../src/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("facilitator migrations", () => {
  it("loads ordered, checksummed migrations", async () => {
    const migrations = await loadMigrationFiles(migrationsDirectory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      "001_facilitator_foundation.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contains the replay, amount and append-only invariants", async () => {
    const [migration] = await loadMigrationFiles(migrationsDirectory);
    expect(migration).toBeDefined();
    const sql = migration?.sql ?? "";

    expect(sql).toContain("quote_id varchar(64) NOT NULL UNIQUE");
    expect(sql).toContain("UNIQUE INDEX settlements_network_txid_unique");
    expect(sql).toContain("CHECK (amount_atomic > 0)");
    expect(sql).toContain("settlement_transitions_append_only");
    expect(sql).not.toMatch(/private[_ ]?key/i);
  });
});
