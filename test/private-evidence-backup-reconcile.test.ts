import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createPendingBackupReconciliation } from "../src/private-evidence-backup-reconcile.js";
const objects = { copy: vi.fn(), readBackup: vi.fn() };
it("bounds batches and validates contracts without opening SQL connections", async () => {
  const pool = { connect: vi.fn() } as unknown as Pool;
  expect(() => createPendingBackupReconciliation(pool, ["SP123.mainnet"], objects)).toThrow();
  const run = createPendingBackupReconciliation(pool, ["ST123.contract"], objects);
  for (const limit of [0, 11, NaN, 1.5]) await expect(run(limit)).rejects.toThrow();
  expect(pool.connect).not.toHaveBeenCalled();
});
it("discards a connection when advisory unlock fails", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ acquired: true }] })
    .mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(Error("fixture-disconnected"));
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  await createPendingBackupReconciliation(pool, ["ST123.contract"], objects)(10);
  expect(release).toHaveBeenCalledWith(true);
});
it("discards a connection on an ambiguous lock acquisition error", async () => {
  const query = vi.fn().mockRejectedValueOnce(Error("fixture-lost-response")), release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
  await expect(createPendingBackupReconciliation(pool, ["ST123.contract"], objects)(10)).rejects.toThrow();
  expect(release).toHaveBeenCalledWith(true);
});
