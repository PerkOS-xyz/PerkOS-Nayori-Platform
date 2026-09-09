import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresPrivateEvidenceStore } from "../src/private-evidence-store.js";
import type { PrivateEvidenceContext } from "../src/private-evidence-security.js";

const provider = "ST3QBWTA0XSA94YDXT13QFH3ZMSZSM1V4Z645YHT9";
const bytes = Buffer.from("private-test-only");
const context: PrivateEvidenceContext = {
  network: "testnet", contract: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
  provider, jobId: "1", sha256: createHash("sha256").update(bytes).digest("hex"),
  mediaType: "text/plain", sizeBytes: bytes.length,
};
const limits = { maxRecords: 100, maxStoredBytes: 100000, retentionSeconds: 3600 };
function fixture() {
  const key = randomBytes(32);
  const keys = { active: vi.fn(async () => ({ keyId: "test", key })), read: vi.fn(async () => key) };
  const pool = { connect: vi.fn(), query: vi.fn() };
  return { keys, pool, store: new PostgresPrivateEvidenceStore(pool as unknown as Pool, keys, limits) };
}
describe("private storage fail-closed boundaries (SQL integration separately)", () => {
  it.each(["get", "put"] as const)("denies %s before key/SQL lookup", async method => {
    const f = fixture(), deny = async () => { throw Error("SECRET AUTH DETAIL"); };
    await expect(method === "get" ? f.store.get(context, deny) : f.store.put(context, bytes, deny)).rejects.toThrow("private_evidence_access_denied");
    expect(f.keys.active).not.toHaveBeenCalled(); expect(f.keys.read).not.toHaveBeenCalled();
    expect(f.pool.connect).not.toHaveBeenCalled(); expect(f.pool.query).not.toHaveBeenCalled();
  });
  it("rejects false digest before opening a transaction", async () => {
    const f = fixture();
    await expect(f.store.put({ ...context, sha256: "0".repeat(64) }, bytes, async () => undefined)).rejects.toThrow("private_evidence_access_denied");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it("rejects oversized bytes before copying or requesting a key", async () => {
    const f = fixture();
    await expect(f.store.put(context, Buffer.alloc(8193), async () => undefined)).rejects.toThrow();
    expect(f.keys.active).not.toHaveBeenCalled(); expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1_073_741_825])("rejects unsafe capacity %s", maxStoredBytes => {
    const f = fixture();
    expect(() => new PostgresPrivateEvidenceStore(f.pool as unknown as Pool, f.keys, { ...limits, maxStoredBytes })).toThrow();
  });
  it("sanitizes SQL failures", async () => {
    const f = fixture(); f.pool.query.mockRejectedValue(Error("PRIVATE DATABASE CONFIG"));
    await expect(f.store.get(context, async () => undefined)).rejects.toThrow("private_evidence_access_denied");
    expect(f.keys.read).not.toHaveBeenCalled();
  });
});
