import { createHash } from "node:crypto";

import type { AppConfig } from "./config.js";
import type {
  ReconciliationCandidate,
  ReconciliationStore,
  SettlementRecord,
} from "./database.js";
import type { QuoteSigner } from "./quote-signing.js";

const TXID_PATTERN = /^0x[0-9a-f]{64}$/;
const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/;

export type ChainObservation =
  | { readonly outcome: "pending"; readonly reason: string }
  | { readonly outcome: "terminal"; readonly status: "failed" | "dropped"; readonly reason: string }
  | {
      readonly outcome: "confirmed";
      readonly blockHeight: number;
      readonly blockHash: string;
      readonly confirmations: number;
    }
  | { readonly outcome: "ambiguous"; readonly reason: string };

export type SettlementChainSource = {
  observe(txid: string): Promise<ChainObservation>;
};

type ObservationFetch = typeof globalThis.fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

async function boundedJson(response: Response): Promise<unknown | null> {
  const maximumBytes = 64 * 1024;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createHiroSettlementChainSource(options: {
  readonly config: AppConfig;
  readonly fetch?: ObservationFetch;
}): SettlementChainSource {
  const request = options.fetch ?? globalThis.fetch;

  async function get(url: string): Promise<Response | null> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.config.stacksObservationTimeoutMs,
    );
    try {
      return await request(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async observe(txid) {
      if (!TXID_PATTERN.test(txid)) {
        return { outcome: "ambiguous", reason: "invalid_stored_txid" };
      }
      const transactionResponse = await get(
        `${options.config.stacksApiUrl}/extended/v3/transactions/${encodeURIComponent(txid)}?include=result`,
      );
      if (!transactionResponse) {
        return { outcome: "ambiguous", reason: "transaction_api_unavailable" };
      }
      if (transactionResponse.status === 404) {
        return { outcome: "pending", reason: "transaction_not_found" };
      }
      if (!transactionResponse.ok) {
        return {
          outcome: "ambiguous",
          reason: `transaction_api_http_${transactionResponse.status}`,
        };
      }
      const rawTransaction = asRecord(await boundedJson(transactionResponse));
      if (!rawTransaction) {
        return { outcome: "ambiguous", reason: "invalid_transaction_response" };
      }
      if (rawTransaction.tx_id !== txid) {
        return { outcome: "ambiguous", reason: "transaction_id_mismatch" };
      }
      const status =
        typeof rawTransaction.status === "string" ? rawTransaction.status.toLowerCase() : "";
      if (status === "pending" || status === "mempool") {
        return { outcome: "pending", reason: "transaction_pending" };
      }
      if (status.startsWith("abort")) {
        return { outcome: "terminal", status: "failed", reason: status.slice(0, 128) };
      }
      if (status.startsWith("drop")) {
        return { outcome: "terminal", status: "dropped", reason: status.slice(0, 128) };
      }
      if (status === "problematic_skipped") {
        return { outcome: "terminal", status: "failed", reason: status };
      }
      if (status !== "success") {
        return { outcome: "ambiguous", reason: "unknown_transaction_status" };
      }

      const block = asRecord(rawTransaction.block);
      const blockHeight = safeInteger(block?.height);
      const blockHash =
        typeof block?.hash === "string" ? block.hash.toLowerCase() : "";
      if (blockHeight === null || !BLOCK_HASH_PATTERN.test(blockHash)) {
        return { outcome: "ambiguous", reason: "invalid_transaction_block" };
      }
      const infoResponse = await get(`${options.config.stacksApiUrl}/v2/info`);
      if (!infoResponse || !infoResponse.ok) {
        return {
          outcome: "ambiguous",
          reason: infoResponse ? `chain_info_http_${infoResponse.status}` : "chain_info_unavailable",
        };
      }
      const info = asRecord(await boundedJson(infoResponse));
      const chainTip = safeInteger(info?.stacks_tip_height);
      if (chainTip === null || chainTip < blockHeight) {
        return { outcome: "ambiguous", reason: "invalid_chain_tip" };
      }
      const confirmations = chainTip - blockHeight + 1;
      if (confirmations < options.config.settlementMinConfirmations) {
        return { outcome: "pending", reason: "insufficient_confirmations" };
      }
      return { outcome: "confirmed", blockHeight, blockHash, confirmations };
    },
  };
}

export type SettlementReceipt = {
  readonly version: 1;
  readonly receiptId: string;
  readonly settlementId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly payer: string;
  readonly txid: string;
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly confirmations: number;
  readonly confirmedAt: string;
};

export type ReconciliationRunResult = {
  readonly claimed: number;
  readonly confirmed: number;
  readonly pending: number;
  readonly terminal: number;
  readonly errors: number;
};

function deterministicId(prefix: "nr" | "nd", settlementId: string): string {
  return `${prefix}_${settlementId.slice(3)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestDigest(candidate: ReconciliationCandidate): string {
  return sha256(
    JSON.stringify({
      method: candidate.requestMethod,
      url: candidate.canonicalUrl,
      bodySha256: candidate.bodyHash,
    }),
  );
}

export function createReconciliationService(options: {
  readonly config: AppConfig;
  readonly store: ReconciliationStore;
  readonly signer: QuoteSigner;
  readonly source: SettlementChainSource;
  readonly now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());

  async function reconcileCandidate(candidate: ReconciliationCandidate): Promise<SettlementRecord> {
    const checkedAt = new Date(now());
    const observation = await options.source.observe(candidate.txid);
    if (observation.outcome === "pending" || observation.outcome === "ambiguous") {
      return options.store.applyReconciliationResult({
        outcome: "pending",
        settlementId: candidate.settlementId,
        checkedAt,
        retryAt: new Date(checkedAt.getTime() + options.config.reconciliationIntervalMs),
        reasonCode: observation.reason,
      });
    }
    if (observation.outcome === "terminal") {
      return options.store.applyReconciliationResult({
        outcome: "terminal",
        settlementId: candidate.settlementId,
        checkedAt,
        status: observation.status,
        reasonCode: observation.reason,
      });
    }

    const receiptId = deterministicId("nr", candidate.settlementId);
    const issuedAt = Math.floor(checkedAt.getTime() / 1_000);
    const receipt: SettlementReceipt = {
      version: 1,
      receiptId,
      settlementId: candidate.settlementId,
      quoteId: candidate.quoteId,
      merchantId: candidate.merchantId,
      network: candidate.network,
      asset: candidate.assetId,
      amount: candidate.amountAtomic,
      payTo: candidate.payTo,
      payer: candidate.payer,
      txid: candidate.txid,
      blockHeight: observation.blockHeight,
      blockHash: observation.blockHash,
      confirmations: observation.confirmations,
      confirmedAt: checkedAt.toISOString(),
    };
    const payload = JSON.stringify(receipt);
    const signedToken = await options.signer.signReceipt({
      merchantId: candidate.merchantId,
      audience: candidate.audience,
      receiptId,
      issuedAt,
      receipt,
    });
    return options.store.applyReconciliationResult({
      outcome: "confirmed",
      settlementId: candidate.settlementId,
      checkedAt,
      blockHeight: observation.blockHeight,
      blockHash: observation.blockHash,
      confirmations: observation.confirmations,
      receipt: {
        receiptId,
        settlementId: candidate.settlementId,
        keyId: options.signer.keyId,
        payloadHash: sha256(payload),
        tokenHash: sha256(signedToken),
        signedToken,
        issuedAt: checkedAt,
      },
      deliveryId: deterministicId("nd", candidate.settlementId),
      requestDigest: requestDigest(candidate),
      deliveryRetryExpiresAt: new Date(
        checkedAt.getTime() + options.config.deliveryRetryTtlSeconds * 1_000,
      ),
    });
  }

  return {
    async runOnce(): Promise<ReconciliationRunResult> {
      const claimedAt = new Date(now());
      const candidates = await options.store.claimSettlementsForReconciliation(
        options.config.reconciliationBatchSize,
        claimedAt,
        new Date(claimedAt.getTime() + options.config.reconciliationLeaseMs),
      );
      const counts = { confirmed: 0, pending: 0, terminal: 0, errors: 0 };
      for (const candidate of candidates) {
        try {
          const result = await reconcileCandidate(candidate);
          if (result.status === "confirmed") counts.confirmed += 1;
          else if (result.status === "failed" || result.status === "dropped") counts.terminal += 1;
          else counts.pending += 1;
        } catch {
          counts.errors += 1;
        }
      }
      return { claimed: candidates.length, ...counts };
    },
  };
}
