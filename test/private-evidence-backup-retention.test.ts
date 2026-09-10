import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createBackupRetention } from "../src/private-evidence-backup-retention.js";
it("requires explicit QA scope and bounded batches before acquiring a connection", async () => {
  const pool = { connect: vi.fn() } as unknown as Pool;
  const objects = { purge: vi.fn() };
  for (const contracts of [[], ["SP123.mainnet"], ["bad"]]) expect(() => createBackupRetention(pool, contracts, objects)).toThrow();
  const run = createBackupRetention(pool, ["ST123.testnet"], objects);
  for (const limit of [0, -1, 11, 1.2, NaN]) await expect(run(limit)).rejects.toThrow();
  expect(pool.connect).not.toHaveBeenCalled(); expect(objects.purge).not.toHaveBeenCalled();
});
