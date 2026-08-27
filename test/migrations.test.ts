import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadMigrationFiles } from "../src/migrations.js";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("facilitator migrations", () => {
  it("loads ordered, checksummed migrations", async () => {
    const migrations = await loadMigrationFiles(migrationsDirectory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      "001_facilitator_foundation.sql",
      "002_merchant_quotes.sql",
      "003_testnet_settlement.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contains the replay, amount and append-only invariants", async () => {
    const migrations = await loadMigrationFiles(migrationsDirectory);
    const sql = migrations.map((migration) => migration.sql).join("\n");

    expect(sql).toContain("quote_id varchar(64) NOT NULL UNIQUE");
    expect(sql).toContain("UNIQUE INDEX settlements_network_txid_unique");
    expect(sql).toContain("CHECK (amount_atomic > 0)");
    expect(sql).toContain("settlement_transitions_append_only");
    expect(sql).toContain("merchants_route_config_v1");
    expect(sql).toContain("quotes_max_lifetime");
    expect(sql).toContain("settlements_verified_material");
    expect(sql).toContain("settlements_broadcast_timestamps");
    expect(sql).not.toMatch(/private[_ ]?key/i);
  });
});
