import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import type {
  ReconciliationCandidate,
  ReconciliationResultInput,
  ReconciliationStore,
  SettlementRecord,
} from "../src/database.js";
import type { QuoteSigner } from "../src/quote-signing.js";
import {
  createHiroSettlementChainSource,
  createReconciliationService,
} from "../src/reconciliation.js";

const TXID = `0x${"a".repeat(64)}`;
const BLOCK_HASH = `0x${"b".repeat(64)}`;
const NOW = 1_700_000_000_000;

function config(confirmations = 2) {
  return loadConfig({
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    NODE_ENV: "test",
    QUOTE_ISSUANCE_ENABLED: "true",
    QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"test":"only"}',
    PAYMENT_VERIFICATION_ENABLED: "true",
    SETTLEMENT_ENABLED: "true",
    RECONCILIATION_ENABLED: "true",
    DELIVERY_LEDGER_ENABLED: "true",
    SETTLEMENT_MIN_CONFIRMATIONS: String(confirmations),
    RECONCILIATION_INTERVAL_MS: "5000",
    RECONCILIATION_LEASE_MS: "30000",
  });
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Hiro settlement chain source", () => {
  it("confirms only canonical v3 success with sufficient depth", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ tx_id: TXID, status: "success", block: { height: 100, hash: BLOCK_HASH } }),
      )
      .mockResolvedValueOnce(json({ stacks_tip_height: 101 }));
    const source = createHiroSettlementChainSource({ config: config(2), fetch: request });

    await expect(source.observe(TXID)).resolves.toEqual({
      outcome: "confirmed",
      blockHeight: 100,
      blockHash: BLOCK_HASH,
      confirmations: 2,
    });
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`/extended/v3/transactions/${TXID}?include=result`),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("keeps missing, mempool and insufficient-depth transactions pending", async () => {
    const missing = createHiroSettlementChainSource({
      config: config(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({}, 404)),
    });
    await expect(missing.observe(TXID)).resolves.toEqual({
      outcome: "pending",
      reason: "transaction_not_found",
    });

    const mempool = createHiroSettlementChainSource({
      config: config(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ tx_id: TXID, status: "pending" })),
    });
    await expect(mempool.observe(TXID)).resolves.toEqual({
      outcome: "pending",
      reason: "transaction_pending",
    });

    const shallowRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ tx_id: TXID, status: "success", block: { height: 100, hash: BLOCK_HASH } }),
      )
      .mockResolvedValueOnce(json({ stacks_tip_height: 100 }));
    const shallow = createHiroSettlementChainSource({ config: config(2), fetch: shallowRequest });
    await expect(shallow.observe(TXID)).resolves.toEqual({
      outcome: "pending",
      reason: "insufficient_confirmations",
    });
  });

  it("maps abort, drop and problematic-skipped to terminal states", async () => {
    const aborted = createHiroSettlementChainSource({
      config: config(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ tx_id: TXID, status: "abort_by_response" })),
    });
    const dropped = createHiroSettlementChainSource({
      config: config(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ tx_id: TXID, status: "dropped_replace_by_fee" })),
    });
    const problematic = createHiroSettlementChainSource({
      config: config(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ tx_id: TXID, status: "problematic_skipped" })),
    });

    await expect(aborted.observe(TXID)).resolves.toEqual({
      outcome: "terminal",
      status: "failed",
      reason: "abort_by_response",
    });
    await expect(dropped.observe(TXID)).resolves.toEqual({
      outcome: "terminal",
      status: "dropped",
      reason: "dropped_replace_by_fee",
    });
    await expect(problematic.observe(TXID)).resolves.toEqual({
      outcome: "terminal",
      status: "failed",
      reason: "problematic_skipped",
    });
  });

  it("treats mismatches, invalid blocks and API failures as ambiguous", async () => {
    const mismatch = createHiroSettlementChainSource({
      config: config(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ tx_id: `0x${"c".repeat(64)}`, status: "success" })),
    });
    const invalidBlock = createHiroSettlementChainSource({
      config: config(),
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ tx_id: TXID, status: "success", block: { height: -1 } })),
    });
    const unavailable = createHiroSettlementChainSource({
      config: config(),
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
    });
    const invalidTipRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ tx_id: TXID, status: "success", block: { height: 100, hash: BLOCK_HASH } }),
      )
      .mockResolvedValueOnce(json({ stacks_tip_height: 99 }));
    const invalidTip = createHiroSettlementChainSource({
      config: config(),
      fetch: invalidTipRequest,
    });
    const oversized = createHiroSettlementChainSource({
      config: config(),
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(64 * 1024 + 1))),
    });

    await expect(mismatch.observe(TXID)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "transaction_id_mismatch",
    });
    await expect(invalidBlock.observe(TXID)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_transaction_block",
    });
    await expect(unavailable.observe(TXID)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "transaction_api_unavailable",
    });
    await expect(invalidTip.observe(TXID)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_chain_tip",
    });
    await expect(oversized.observe(TXID)).resolves.toEqual({
      outcome: "ambiguous",
      reason: "invalid_transaction_response",
    });
  });
});

const candidate: ReconciliationCandidate = {
  settlementId: `ns_${"1".repeat(32)}`,
  quoteId: "nq_test",
  merchantId: "merchant-1",
  network: "stacks:2147483648",
  txid: TXID,
  payer: "ST2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B",
  rawTxHash: "d".repeat(64),
  verifierVersion: "@perkos/agent-sdk@0.3.0",
  verifierChecksum: "e".repeat(64),
  status: "broadcast",
  failureReason: null,
  broadcastAttemptedAt: new Date(NOW - 1000),
  broadcastAt: new Date(NOW - 1000),
  createdAt: new Date(NOW - 1000),
  updatedAt: new Date(NOW - 1000),
  audience: "merchant:research",
  requestMethod: "POST",
  canonicalUrl: "https://merchant.example/v1/research",
  bodyHash: "f".repeat(64),
  assetId: "stacks:2147483648/sip010:test.sbtc-token.sbtc-token",
  amountAtomic: "1000",
  payTo: "ST1THWXQ8368SDN2MJGE4BMDKMCHZ2GSVTSQDA7QF",
};

class ReconciliationMemoryStore implements ReconciliationStore {
  readonly applied: ReconciliationResultInput[] = [];
  constructor(readonly candidates: readonly ReconciliationCandidate[] = [candidate]) {}

  async claimSettlementsForReconciliation() {
    return this.candidates;
  }

  async applyReconciliationResult(input: ReconciliationResultInput): Promise<SettlementRecord> {
    this.applied.push(input);
    return {
      ...candidate,
      status:
        input.outcome === "confirmed"
          ? "confirmed"
          : input.outcome === "terminal"
            ? input.status
            : "pending",
    };
  }
}

function signer() {
  const signReceipt = vi.fn(async () => "signed-receipt-token");
  const value: QuoteSigner = {
    keyId: "active-key",
    publicJwks: { keys: [] },
    sign: vi.fn(async () => "quote"),
    signReceipt,
    verify: vi.fn(),
  };
  return { signReceipt, value };
}

describe("reconciliation service", () => {
  it("creates one deterministic signed receipt and delivery ledger input", async () => {
    const store = new ReconciliationMemoryStore();
    const receiptSigner = signer();
    const service = createReconciliationService({
      config: config(2),
      store,
      signer: receiptSigner.value,
      source: {
        observe: async () => ({
          outcome: "confirmed",
          blockHeight: 100,
          blockHash: BLOCK_HASH,
          confirmations: 2,
        }),
      },
      now: () => NOW,
    });

    await expect(service.runOnce()).resolves.toEqual({
      claimed: 1,
      confirmed: 1,
      pending: 0,
      terminal: 0,
      errors: 0,
    });
    expect(receiptSigner.signReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "merchant:research",
        receiptId: `nr_${"1".repeat(32)}`,
        receipt: expect.objectContaining({ txid: TXID, confirmations: 2 }),
      }),
    );
    expect(store.applied[0]).toMatchObject({
      outcome: "confirmed",
      deliveryId: `nd_${"1".repeat(32)}`,
      receipt: {
        receiptId: `nr_${"1".repeat(32)}`,
        keyId: "active-key",
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("persists ambiguous observations as pending without signing a receipt", async () => {
    const store = new ReconciliationMemoryStore();
    const receiptSigner = signer();
    const service = createReconciliationService({
      config: config(),
      store,
      signer: receiptSigner.value,
      source: { observe: async () => ({ outcome: "ambiguous", reason: "offline" }) },
      now: () => NOW,
    });

    await expect(service.runOnce()).resolves.toMatchObject({ pending: 1, errors: 0 });
    expect(store.applied[0]).toMatchObject({
      outcome: "pending",
      reasonCode: "offline",
      retryAt: new Date(NOW + 5000),
    });
    expect(receiptSigner.signReceipt).not.toHaveBeenCalled();
  });
});
