import { getNayoriX402Asset } from "@perkos/agent-sdk";
import { z } from "zod";
import type { AppConfig } from "./config.js";

export const PUBLIC_PAYMENT_LIMIT = 25;
const hex = z.string().regex(/^0x[0-9a-f]{64}$/);
const integer = z.string().regex(/^(0|[1-9][0-9]{0,38})$/);
export const publicPaymentRow = z.object({
  txid: hex, network: z.string(), canonicalUrl: z.string(), assetId: z.string(),
  amountAtomic: integer, payer: z.string().min(1).max(64), payTo: z.string().min(1).max(64),
  blockHeight: z.coerce.number().int().positive().safe(), blockHash: hex,
  confirmedAt: z.coerce.date(), deliveryStatus: z.enum(["delivery_pending", "delivering", "delivered", "failed", "expired"]).nullable(),
});
export type PublicPaymentRow = z.infer<typeof publicPaymentRow>;
export interface PublicPaymentStore {
  listPublicPayments(network: string, urls: readonly string[]): Promise<PublicPaymentRow[]>;
}
export interface PublicPayment {
  txid: string; protocol: "x402" | "mpp"; asset: "STX" | "sBTC" | "USDCx";
  amountAtomic: string; decimals: number; payer: string; payTo: string; feeMicroStx: string;
  blockHeight: number; confirmedAt: string; deliveryStatus: string;
}
export interface PublicPaymentSnapshot {
  schemaVersion: 1; network: string; generatedAt: string; dataStatus: "live";
  scope: "nayori-public-resources"; limit: number; hasMore: boolean; excludedCount: number;
  payments: PublicPayment[];
}
export interface PublicPaymentService { snapshot(): Promise<PublicPaymentSnapshot> }

const chainSchema = z.object({
  tx_id: hex, tx_status: z.string(), canonical: z.boolean(), is_unanchored: z.boolean(),
  block_height: z.number().int(), block_hash: z.string(), sender_address: z.string(), fee_rate: integer,
  tx_result: z.object({ repr: z.string() }), event_count: z.number().int().nonnegative(),
  events: z.array(z.object({ event_type: z.string(), asset: z.object({
    asset_event_type: z.string(), sender: z.string().optional(), recipient: z.string().optional(),
    amount: z.string().optional(), asset_id: z.string().optional(),
  }).optional() })).max(100),
});

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("empty source");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) throw new Error("oversized source");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createPublicPaymentService(options: {
  config: AppConfig; store: PublicPaymentStore; fetch?: typeof fetch; now?: () => number;
}): PublicPaymentService {
  const { config, store } = options;
  const request = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const network = config.stacksNetwork === "mainnet" ? "stacks:1" : "stacks:2147483648";
  const urls = [config.publicResourceUrl, config.mppResourceUrl];
  const assets = (["stx", "sbtc", "usdcx"] as const).map(id => ({ id, ...getNayoriX402Asset(config.stacksNetwork, id) }));
  let cached: { until: number; value: PublicPaymentSnapshot } | undefined;
  let pending: Promise<PublicPaymentSnapshot> | undefined;
  let failedUntil = 0;
  async function load(): Promise<PublicPaymentSnapshot> {
    const rows = await store.listPublicPayments(network, urls);
    if (rows.length > PUBLIC_PAYMENT_LIMIT + 1) throw new Error("unbounded store response");
    const signal = AbortSignal.timeout(8_000);
    const records: (PublicPayment | null)[] = [];
    let next = 0;
    const seen = new Set<string>();
    async function worker() {
      for (;;) {
        const index = next++;
        if (index >= Math.min(rows.length, PUBLIC_PAYMENT_LIMIT)) break;
        const row = publicPaymentRow.parse(rows[index]);
        if (row.network !== network || !urls.includes(row.canonicalUrl) || seen.has(row.txid)) throw new Error("invalid source scope");
        seen.add(row.txid);
        const asset = assets.find(a => a.canonicalAssetId === row.assetId);
        const protocol = row.canonicalUrl === config.mppResourceUrl ? "mpp" : "x402";
        if (!asset || (protocol === "mpp" && asset.id !== "usdcx")) throw new Error("invalid asset");
        const response = await request(`${config.stacksApiUrl}/extended/v1/tx/${row.txid}`, {
          signal, redirect: "error", headers: { accept: "application/json" },
        });
        if (response.status === 404) { records[index] = null; continue; }
        if (!response.ok) throw new Error("chain unavailable");
        const tx = chainSchema.parse(await boundedJson(response));
        const transfers = tx.events.filter(e => e.asset?.asset_event_type === "transfer" &&
          ["stx_asset", "fungible_token_asset"].includes(e.event_type));
        const event = transfers[0]?.asset;
        const valid = tx.tx_id === row.txid && tx.tx_status === "success" && tx.canonical && !tx.is_unanchored &&
          tx.block_height === row.blockHeight && tx.block_hash === row.blockHash && tx.sender_address === row.payer &&
          tx.tx_result.repr === "(ok true)" && tx.event_count === tx.events.length && transfers.length === 1 &&
          event?.sender === row.payer && event.recipient === row.payTo && event.amount === row.amountAtomic &&
          (asset.id === "stx" ? transfers[0]?.event_type === "stx_asset" :
            transfers[0]?.event_type === "fungible_token_asset" && event.asset_id === asset.postConditionAsset);
        records[index] = valid ? {
          txid: row.txid, protocol, asset: asset.id === "stx" ? "STX" : asset.id === "sbtc" ? "sBTC" : "USDCx",
          amountAtomic: row.amountAtomic, decimals: asset.decimals, payer: row.payer, payTo: row.payTo,
          feeMicroStx: tx.fee_rate, blockHeight: row.blockHeight, confirmedAt: row.confirmedAt.toISOString(),
          deliveryStatus: row.deliveryStatus ?? "unavailable",
        } : null;
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    const payments = records.filter((p): p is PublicPayment => p !== null);
    return { schemaVersion: 1, network, generatedAt: new Date(now()).toISOString(), dataStatus: "live",
      scope: "nayori-public-resources", limit: PUBLIC_PAYMENT_LIMIT, hasMore: rows.length > PUBLIC_PAYMENT_LIMIT,
      excludedCount: records.length - payments.length, payments };
  }
  return { snapshot() {
    if (cached && cached.until > now()) return Promise.resolve(cached.value);
    if (pending) return pending;
    if (failedUntil > now()) return Promise.reject(new Error("source cooling down"));
    pending = load().then(value => { cached = { value, until: now() + 60_000 }; return value; })
      .catch(error => { failedUntil = now() + 10_000; throw error; }).finally(() => { pending = undefined; });
    return pending;
  } };
}
