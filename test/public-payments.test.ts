import { describe, expect, it, vi } from "vitest";
import { getNayoriX402Asset } from "@perkos/agent-sdk";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createPublicPaymentService, type PublicPaymentRow } from "../src/public-payments.js";

const env = { DATABASE_URL: "postgresql://localhost/test", NODE_ENV: "test" };
const config = loadConfig(env);
const payer = "ST1VSKCGJCBV3EBS8GWPJ9FD1QARHQ9EN8S49PG8T";
const recipient = "ST2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH";
function row(id = 1): PublicPaymentRow {
  return { txid: `0x${id.toString(16).padStart(64, "0")}`, network: "stacks:2147483648",
    canonicalUrl: config.publicResourceUrl, assetId: getNayoriX402Asset("testnet", "stx").canonicalAssetId,
    amountAtomic: "4000", payer, payTo: recipient, blockHeight: 100,
    blockHash: `0x${"b".repeat(64)}`, confirmedAt: new Date("2026-09-03T12:00:00Z"), deliveryStatus: "delivered" };
}
function chain(r = row(), asset = "stx") {
  return { tx_id: r.txid, tx_status: "success", canonical: true, is_unanchored: false,
    block_height: r.blockHeight, block_hash: r.blockHash, sender_address: r.payer, fee_rate: "3000",
    tx_result: { repr: "(ok true)" }, event_count: 1, events: [{ event_type: asset === "stx" ? "stx_asset" : "fungible_token_asset",
      asset: { asset_event_type: "transfer", sender: r.payer, recipient: r.payTo, amount: r.amountAtomic,
        ...(asset === "stx" ? {} : { asset_id: getNayoriX402Asset("testnet", asset as "sbtc" | "usdcx").postConditionAsset }) } }] };
}
function fixture(rows = [row()], tx: unknown = chain()) {
  const store = { listPublicPayments: vi.fn(async () => rows) };
  const request = vi.fn<typeof fetch>(async () => Response.json(tx));
  let time = Date.parse("2026-09-03T13:00:00Z");
  const service = createPublicPaymentService({ config, store, fetch: request, now: () => time });
  return { store, request, service, advance: () => { time += 61_000; } };
}

describe("public payment evidence", () => {
  it("publishes a strict projection without settlement IDs or delivery credentials", async () => {
    const r = { ...row(), settlementId: "SECRET", signedToken: "SECRET", rawTransaction: "SECRET" };
    const { service, store, request } = fixture([r]);
    const value = await service.snapshot();
    expect(value.payments).toHaveLength(1);
    expect(value.payments[0]).toMatchObject({ protocol: "x402", asset: "STX", amountAtomic: "4000", feeMicroStx: "3000", payTo: recipient });
    expect(JSON.stringify(value)).not.toContain("SECRET");
    expect(store.listPublicPayments).toHaveBeenCalledWith("stacks:2147483648", [config.publicResourceUrl, config.mppResourceUrl]);
    expect(request.mock.calls[0]?.[0]).toBe(`${config.stacksApiUrl}/extended/v1/tx/${r.txid}`);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { accept: "application/json" } });
  });
  it.each(["sbtc", "usdcx"] as const)("verifies canonical %s assets with exact integer amounts", async asset => {
    const r = { ...row(), assetId: getNayoriX402Asset("testnet", asset).canonicalAssetId,
      canonicalUrl: asset === "usdcx" ? config.mppResourceUrl : config.publicResourceUrl, amountAtomic: "90071992547409931234" };
    const value = await fixture([r], chain(r, asset)).service.snapshot();
    expect(value.payments[0]?.amountAtomic).toBe(r.amountAtomic);
    expect(value.payments[0]?.protocol).toBe(asset === "usdcx" ? "mpp" : "x402");
  });
  it.each([
    ["pending", { tx_status: "pending" }], ["reorg", { canonical: false }],
    ["unanchored", { is_unanchored: true }], ["wrong block", { block_height: 101 }],
    ["wrong hash", { block_hash: "other" }], ["wrong payer", { sender_address: recipient }],
    ["aborted", { tx_result: { repr: "(err u1)" } }], ["truncated events", { event_count: 2 }],
  ])("excludes %s without fabricating a success", async (_name, patch) => {
    expect(await fixture([row()], { ...chain(), ...patch }).service.snapshot()).toMatchObject({ payments: [], excludedCount: 1 });
  });
  it("rejects double transfers and wrong amounts", async () => {
    const tx = chain();
    expect((await fixture([row()], { ...tx, events: [...tx.events, ...tx.events], event_count: 2 }).service.snapshot()).payments).toEqual([]);
    tx.events[0]!.asset.amount = "4001";
    expect((await fixture([row()], tx).service.snapshot()).payments).toEqual([]);
  });
  it("does not accept a counterfeit token", async () => {
    const r = { ...row(), assetId: getNayoriX402Asset("testnet", "usdcx").canonicalAssetId };
    const tx = chain(r, "usdcx"); tx.events[0]!.asset.asset_id = "counterfeit::token";
    expect((await fixture([r], tx).service.snapshot()).payments).toEqual([]);
  });
  it.each([{ network: "stacks:1" }, { canonicalUrl: "https://private.example/resource" }, { assetId: "unknown" }, { canonicalUrl: config.mppResourceUrl }])("fails closed on invalid ledger scope %j", async patch => {
    await expect(fixture([{ ...row(), ...patch }]).service.snapshot()).rejects.toThrow();
  });
  it("deduplicates by rejecting duplicate transaction rows", async () => {
    await expect(fixture([row(), row()]).service.snapshot()).rejects.toThrow();
  });
  it("singleflights requests, caches 60 seconds and does not serve stale success after an outage", async () => {
    const f = fixture(); await Promise.all([f.service.snapshot(), f.service.snapshot()]);
    await f.service.snapshot(); expect(f.request).toHaveBeenCalledTimes(1);
    f.advance(); f.request.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(f.service.snapshot()).rejects.toThrow();
    await expect(f.service.snapshot()).rejects.toThrow(); expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("bounds history and concurrent chain lookups", async () => {
    const rows = Array.from({ length: 26 }, (_, i) => row(i + 1));
    let active = 0; let maximum = 0; let calls = 0;
    const service = createPublicPaymentService({ config, store: { listPublicPayments: async () => rows }, fetch: async url => {
      active++; maximum = Math.max(maximum, active); calls++;
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return Response.json(chain(rows.find(r => String(url).endsWith(r.txid))!));
    } });
    expect(await service.snapshot()).toMatchObject({ hasMore: true, excludedCount: 0 });
    expect(calls).toBe(25); expect(maximum).toBeLessThanOrEqual(4);
  });
  it("bounds response bytes and treats malformed chain data as unavailable", async () => {
    const f = fixture(); f.request.mockResolvedValue(new Response("x".repeat(128 * 1024 + 1)));
    await expect(f.service.snapshot()).rejects.toThrow();
    await expect(fixture([row()], {}).service.snapshot()).rejects.toThrow();
  });
  it("returns a verified empty window only when the store is empty", async () => {
    const f = fixture([]); expect(await f.service.snapshot()).toMatchObject({ payments: [], hasMore: false });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe("public payment HTTP boundary", () => {
  const database = { ping: async () => {}, close: async () => {} };
  const logger = { info: () => {}, error: () => {} };
  it("is opt-in and refuses enablement without the service", async () => {
    expect((await createApp({ config, database, logger }).request("/v1/public/payments")).status).toBe(404);
    expect(() => createApp({ config: { ...config, publicPaymentEvidenceEnabled: true }, database, logger })).toThrow();
  });
  it("exposes CORS public data, rejects parameters and sanitizes failures", async () => {
    const snapshot = vi.fn(async () => fixture([]).service.snapshot());
    const app = createApp({ config: { ...config, publicPaymentEvidenceEnabled: true }, database, logger, publicPaymentService: { snapshot } });
    const ok = await app.request("/v1/public/payments");
    expect(ok.status).toBe(200); expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect((await app.request("/v1/public/payments?merchant=private")).status).toBe(400);
    snapshot.mockRejectedValue(new Error("SECRET"));
    const unavailable = await app.request("/v1/public/payments"); expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("SECRET");
    const spec = await (await app.request("/openapi.json")).json() as { paths: Record<string, unknown> };
    expect(spec.paths["/v1/public/payments"]).toBeDefined();
  });
  it("requires the pinned chain origin and distinct protocol URLs", () => {
    expect(loadConfig(env).publicPaymentEvidenceEnabled).toBe(false);
    expect(() => loadConfig({ ...env, PUBLIC_PAYMENT_EVIDENCE_ENABLED: "true", STACKS_API_URL: "https://evil.example" })).toThrow();
    expect(() => loadConfig({ ...env, PUBLIC_PAYMENT_EVIDENCE_ENABLED: "true", MPP_RESOURCE_URL: config.publicResourceUrl })).toThrow();
  });
});
