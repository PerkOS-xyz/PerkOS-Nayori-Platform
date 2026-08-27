import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  getNayoriX402Asset,
  NayoriX402DirectVerificationError,
  type NayoriX402VerifiedDirectPayment,
} from "@perkos/agent-sdk";

import type { BroadcastResult, TransactionBroadcaster } from "../src/broadcast.js";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  DeliveryStoreError,
  type DeliveryLedgerRecord,
  type DeliveryLedgerStore,
  SettlementStoreError,
  type IssuedQuoteRecord,
  type MerchantQuoteStore,
  type ReserveSettlementResult,
  type SettlementRecord,
  type SettlementReservation,
  type SettlementStatus,
  type SettlementStore,
  type StoredQuoteRecord,
} from "../src/database.js";
import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  type MerchantRecord,
} from "../src/merchant.js";
import { createQuoteSigner } from "../src/quote-signing.js";
import { createQuoteService } from "../src/quotes.js";
import { createSettlementService } from "../src/settlement.js";
import type { AppLogger } from "../src/logger.js";

const NOW = 1_700_000_000_000;
const PAY_TO = "ST1THWXQ8368SDN2MJGE4BMDKMCHZ2GSVTSQDA7QF";
const PAYER = "ST2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
const TXID = `0x${"a".repeat(64)}`;

const merchant: MerchantRecord = {
  merchantId: "merchant-1",
  allowedOrigins: ["https://merchant.example"],
  allowedAudiences: ["merchant:research"],
  recipientAllowlist: [PAY_TO],
  routeConfig: {
    version: 1,
    routes: {
      research: {
        method: "POST",
        pathPrefix: "/v1/research",
        audience: "merchant:research",
        network: "testnet",
        asset: "sbtc",
        amount: "1000",
        payTo: PAY_TO,
        ttlSeconds: 120,
      },
    },
  },
};

class MemoryStore implements MerchantQuoteStore, SettlementStore, DeliveryLedgerStore {
  readonly quotes = new Map<string, StoredQuoteRecord>();
  readonly settlements = new Map<string, SettlementRecord>();
  delivery: DeliveryLedgerRecord | null = null;

  constructor(readonly expectedApiKeyHash: string) {}

  async ping(): Promise<void> {}
  async close(): Promise<void> {}

  async findActiveMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRecord | null> {
    return apiKeyHash === this.expectedApiKeyHash ? merchant : null;
  }

  async insertIssuedQuote(record: IssuedQuoteRecord): Promise<void> {
    this.quotes.set(record.quoteId, { ...record, status: "issued" });
  }

  async findStoredQuote(quoteId: string, merchantId: string): Promise<StoredQuoteRecord | null> {
    const quote = this.quotes.get(quoteId);
    return quote?.merchantId === merchantId ? quote : null;
  }

  async reserveSettlement(input: SettlementReservation): Promise<ReserveSettlementResult> {
    const quote = this.quotes.get(input.quoteId);
    if (!quote || quote.signedTokenHash !== input.expectedSignedTokenHash) {
      throw new SettlementStoreError("quote_unavailable");
    }
    const existing = [...this.settlements.values()].find(
      (candidate) => candidate.quoteId === input.quoteId,
    );
    if (existing) {
      if (existing.txid !== input.txid || existing.rawTxHash !== input.rawTxHash) {
        throw new SettlementStoreError("payment_replayed");
      }
      return { created: false, settlement: existing };
    }
    if (quote.status !== "issued") throw new SettlementStoreError("quote_unavailable");
    const duplicate = [...this.settlements.values()].some(
      (candidate) => candidate.network === input.network && candidate.txid === input.txid,
    );
    if (duplicate) throw new SettlementStoreError("payment_replayed");
    const timestamp = new Date(NOW);
    const settlement: SettlementRecord = {
      settlementId: input.settlementId,
      quoteId: input.quoteId,
      merchantId: input.merchantId,
      network: input.network,
      txid: input.txid,
      payer: input.payer,
      rawTxHash: input.rawTxHash,
      verifierVersion: input.verifierVersion,
      verifierChecksum: input.verifierChecksum,
      status: "validated",
      failureReason: null,
      broadcastAttemptedAt: null,
      broadcastAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.settlements.set(settlement.settlementId, settlement);
    this.quotes.set(input.quoteId, { ...quote, status: "reserved" });
    return { created: true, settlement };
  }

  async updateSettlementStatus(
    settlementId: string,
    _fromStatus: "validated",
    toStatus: "broadcast" | "pending" | "failed",
    reasonCode: string | null,
    attemptedAt: Date,
  ): Promise<SettlementRecord> {
    const current = this.settlements.get(settlementId)!;
    const settlement: SettlementRecord = {
      ...current,
      status: toStatus,
      failureReason: reasonCode,
      broadcastAttemptedAt: attemptedAt,
      broadcastAt: toStatus === "broadcast" ? attemptedAt : null,
      updatedAt: attemptedAt,
    };
    this.settlements.set(settlementId, settlement);
    return settlement;
  }

  async findSettlementForMerchant(
    settlementId: string,
    merchantId: string,
  ): Promise<SettlementRecord | null> {
    const settlement = this.settlements.get(settlementId);
    return settlement?.merchantId === merchantId ? settlement : null;
  }

  async claimDelivery(
    settlementId: string,
    merchantId: string,
    _claimedAt: Date,
  ): Promise<DeliveryLedgerRecord> {
    void _claimedAt;
    if (
      !this.delivery ||
      this.delivery.settlementId !== settlementId ||
      this.delivery.merchantId !== merchantId
    ) {
      throw new DeliveryStoreError("delivery_not_found");
    }
    if (this.delivery.status === "delivery_pending") {
      this.delivery = {
        ...this.delivery,
        status: "delivering",
        attemptCount: this.delivery.attemptCount + 1,
      };
    }
    return this.delivery;
  }

  async completeDelivery(
    settlementId: string,
    merchantId: string,
    responseDigest: string,
    _completedAt: Date,
  ): Promise<DeliveryLedgerRecord> {
    void _completedAt;
    if (
      !this.delivery ||
      this.delivery.settlementId !== settlementId ||
      this.delivery.merchantId !== merchantId
    ) {
      throw new DeliveryStoreError("delivery_not_found");
    }
    if (this.delivery.status === "delivered") {
      if (this.delivery.responseDigest !== responseDigest) {
        throw new DeliveryStoreError("delivery_digest_conflict");
      }
      return this.delivery;
    }
    if (this.delivery.status !== "delivering") {
      throw new DeliveryStoreError("delivery_not_claimed");
    }
    this.delivery = { ...this.delivery, status: "delivered", responseDigest };
    return this.delivery;
  }
}

function verifiedPayment(overrides: Partial<NayoriX402VerifiedDirectPayment> = {}) {
  return {
    network: "testnet" as const,
    x402Network: "stacks:2147483648" as const,
    asset: "sbtc" as const,
    assetDefinition: getNayoriX402Asset("testnet", "sbtc"),
    amount: 1000n,
    payer: PAYER,
    payTo: PAY_TO,
    transaction: "00",
    transactionHash: TXID,
    transactionId: TXID,
    originNonce: 1n,
    originFee: 300n,
    sponsored: false,
    quoteId: "placeholder",
    quoteFingerprint: `ny1_${"a".repeat(27)}`,
    ...overrides,
  } satisfies NayoriX402VerifiedDirectPayment;
}

async function context(
  outcome: BroadcastResult = { outcome: "accepted", txid: TXID },
  paymentRateLimit = 60,
  deliveryLedgerEnabled = false,
) {
  const { privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const privateJwk = {
    ...(await exportJWK(privateKey)),
    kid: "settlement-test",
    alg: "EdDSA",
    use: "sig",
  };
  const config: AppConfig = loadConfig({
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    NODE_ENV: "test",
    SERVICE_ORIGIN: "https://api.nayori.ai",
    QUOTE_ISSUANCE_ENABLED: "true",
    QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(privateJwk),
    PAYMENT_VERIFICATION_ENABLED: "true",
    PAYMENT_RATE_LIMIT_PER_MINUTE: String(paymentRateLimit),
    SETTLEMENT_ENABLED: "true",
    RECONCILIATION_ENABLED: String(deliveryLedgerEnabled),
    DELIVERY_LEDGER_ENABLED: String(deliveryLedgerEnabled),
    STACKS_NETWORK: "testnet",
  });
  const apiKey = generateMerchantApiKey();
  const store = new MemoryStore(hashMerchantApiKey(apiKey));
  const signer = await createQuoteSigner(config);
  const quoteService = createQuoteService({ config, store, signer, now: () => NOW });
  const issued = await quoteService.issue(`Bearer ${apiKey}`, {
    routeId: "research",
    request: {
      method: "POST",
      url: "https://merchant.example/v1/research/stacks",
      body: '{"topic":"stacks"}',
    },
  });
  const broadcast = vi.fn(async () => outcome);
  const broadcaster: TransactionBroadcaster = { broadcast };
  const verify = vi.fn(async () =>
    verifiedPayment({
      quoteId: issued.quoteId,
      quoteFingerprint: issued.response.paymentRequirements.extra.quoteFingerprint as string,
    }),
  );
  const service = createSettlementService({
    config,
    store,
    signer,
    broadcaster,
    verifier: verify,
    now: () => NOW + 10_000,
    ...(deliveryLedgerEnabled ? { deliveryStore: store } : {}),
  });
  const input = {
    signedQuote: issued.response.signedQuote,
    paymentRequirements: issued.response.paymentRequirements,
    paymentPayload: {
      x402Version: 2,
      accepted: issued.response.paymentRequirements,
      payload: { transaction: "00" },
      extensions: {},
    },
    request: {
      method: "POST",
      url: "https://merchant.example/v1/research/stacks",
      body: '{"topic":"stacks"}',
    },
  };
  return {
    apiKey,
    broadcast,
    config,
    input,
    issued,
    quoteService,
    service,
    signer,
    store,
    verify,
  };
}

describe("payment verification and testnet settlement", () => {
  it("refuses unsafe settlement and delivery runtime wiring", async () => {
    const settlement = await context();
    expect(() =>
      createSettlementService({
        config: settlement.config,
        store: settlement.store,
        signer: settlement.signer,
        verifier: settlement.verify,
      }),
    ).toThrow(/transaction broadcaster/i);

    const delivery = await context({ outcome: "accepted", txid: TXID }, 60, true);
    expect(() =>
      createSettlementService({
        config: delivery.config,
        store: delivery.store,
        signer: delivery.signer,
        broadcaster: { broadcast: delivery.broadcast },
        verifier: delivery.verify,
      }),
    ).toThrow(/delivery store/i);
  });

  it("authenticates the merchant and verifies without reserving or broadcasting", async () => {
    const test = await context();
    const verification = await test.service.verify(`Bearer ${test.apiKey}`, test.input);

    expect(verification).toMatchObject({
      status: "verified",
      merchantId: "merchant-1",
      quoteId: test.issued.quoteId,
      txid: TXID,
      sponsored: false,
    });
    expect(test.store.settlements.size).toBe(0);
    expect(test.broadcast).not.toHaveBeenCalled();
  });

  it("rejects invalid credentials, token tampering and SDK verifier failures", async () => {
    const test = await context();
    await expect(test.service.verify(undefined, test.input)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, {
        ...test.input,
        signedQuote: `${test.input.signedQuote}tampered`,
      }),
    ).rejects.toMatchObject({ code: "invalid_signed_quote", status: 422 });

    test.verify.mockRejectedValueOnce(
      new NayoriX402DirectVerificationError("memo_mismatch", "bad memo"),
    );
    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, test.input),
    ).rejects.toMatchObject({ code: "memo_mismatch", status: 422 });
  });

  it("rejects a token hash mismatch and a revoked quote before SDK verification", async () => {
    const test = await context();
    const stored = test.store.quotes.get(test.issued.quoteId)!;
    test.store.quotes.set(test.issued.quoteId, {
      ...stored,
      signedTokenHash: "0".repeat(64),
    });
    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, test.input),
    ).rejects.toMatchObject({ code: "quote_record_mismatch", status: 422 });
    expect(test.verify).not.toHaveBeenCalled();

    test.store.quotes.set(test.issued.quoteId, { ...stored, status: "revoked" });
    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, test.input),
    ).rejects.toMatchObject({ code: "quote_unavailable", status: 409 });
    expect(test.verify).not.toHaveBeenCalled();
  });

  it("rejects sponsored payments as a separate security boundary", async () => {
    const test = await context();
    test.verify.mockResolvedValueOnce(
      verifiedPayment({ sponsored: true, transactionId: undefined }),
    );

    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, test.input),
    ).rejects.toMatchObject({ code: "sponsorship_not_supported", status: 422 });
  });

  it("rate limits authenticated payment operations before payment parsing", async () => {
    const test = await context({ outcome: "accepted", txid: TXID }, 1);
    await test.service.verify(`Bearer ${test.apiKey}`, test.input);

    await expect(
      test.service.verify(`Bearer ${test.apiKey}`, { invalid: "body" }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterSeconds: 60 });
    expect(test.verify).toHaveBeenCalledTimes(1);
  });

  it("reserves once, broadcasts once and returns the existing settlement on retry", async () => {
    const test = await context();
    const first = await test.service.settle(`Bearer ${test.apiKey}`, test.input);
    const second = await test.service.settle(`Bearer ${test.apiKey}`, test.input);

    expect(first).toMatchObject({
      replayed: false,
      settlement: { status: "broadcast", txid: TXID, confirmed: false },
    });
    expect(second).toMatchObject({
      replayed: true,
      settlement: { settlementId: first.settlement.settlementId, status: "broadcast" },
    });
    expect([...test.store.settlements.values()][0]).toMatchObject({
      verifierVersion: "@perkos/agent-sdk@0.3.2",
      verifierChecksum: "ebff7ec0e42b59c0767714195953a60acfee01df630bc92f1d8c9287986f32f7",
    });
    expect(test.broadcast).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ outcome: "ambiguous", reason: "broadcast_timeout" } as const, "pending"],
    [{ outcome: "accepted", txid: `0x${"b".repeat(64)}` } as const, "pending"],
    [{ outcome: "rejected", reason: "BadNonce" } as const, "failed"],
  ] satisfies readonly [BroadcastResult, SettlementStatus][]) (
    "persists broadcast outcome %# without retrying",
    async (outcome, expectedStatus) => {
      const test = await context(outcome);
      const result = await test.service.settle(`Bearer ${test.apiKey}`, test.input);

      expect(result.settlement.status).toBe(expectedStatus);
      expect(result.settlement.deliveryAvailable).toBe(false);
      expect(test.broadcast).toHaveBeenCalledTimes(1);
    },
  );

  it("isolates settlement status by authenticated merchant", async () => {
    const test = await context();
    const result = await test.service.settle(`Bearer ${test.apiKey}`, test.input);

    await expect(
      test.service.get(undefined, result.settlement.settlementId),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      test.service.get(`Bearer ${test.apiKey}`, "ns_invalid"),
    ).rejects.toMatchObject({ code: "settlement_not_found", status: 404 });
    await expect(
      test.service.get(`Bearer ${test.apiKey}`, result.settlement.settlementId),
    ).resolves.toMatchObject({ settlementId: result.settlement.settlementId, txid: TXID });
  });

  it("exposes only authenticated verify, settle and status routes when enabled", async () => {
    const test = await context();
    const logger: AppLogger = { info() {}, error() {} };
    const app = createApp({
      config: test.config,
      database: test.store,
      logger,
      quoteService: test.quoteService,
      settlementService: test.service,
    });
    const headers = {
      authorization: `Bearer ${test.apiKey}`,
      "content-type": "application/json",
    };
    const verifyResponse = await app.request("/v1/x402/verify", {
      method: "POST",
      headers,
      body: JSON.stringify(test.input),
    });
    const settleResponse = await app.request("/v1/x402/settle", {
      method: "POST",
      headers,
      body: JSON.stringify(test.input),
    });
    const settled = (await settleResponse.json()) as {
      settlement: { settlementId: string };
    };
    const statusResponse = await app.request(
      `/v1/x402/settlements/${settled.settlement.settlementId}`,
      { headers },
    );

    expect(verifyResponse.status).toBe(200);
    expect(settleResponse.status).toBe(202);
    expect(statusResponse.status).toBe(200);
    const openapi = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(openapi.paths).toHaveProperty("/v1/x402/settle");
  });

  it("claims and completes a confirmed delivery idempotently", async () => {
    const test = await context({ outcome: "accepted", txid: TXID }, 60, true);
    const settlementId = `ns_${"1".repeat(32)}`;
    test.store.delivery = {
      deliveryId: `nd_${"1".repeat(32)}`,
      settlementId,
      merchantId: "merchant-1",
      status: "delivery_pending",
      attemptCount: 0,
      responseDigest: null,
      retryExpiresAt: new Date(NOW + 60_000),
      receiptId: `nr_${"1".repeat(32)}`,
      receiptToken: "signed-receipt",
    };

    const firstClaim = await test.service.claimDelivery(`Bearer ${test.apiKey}`, settlementId);
    const secondClaim = await test.service.claimDelivery(`Bearer ${test.apiKey}`, settlementId);
    expect(firstClaim).toMatchObject({
      deliveryId: `nd_${"1".repeat(32)}`,
      status: "delivering",
      attemptCount: 1,
      receipt: "signed-receipt",
    });
    expect(secondClaim).toEqual(firstClaim);

    const digest = "c".repeat(64);
    const completed = await test.service.completeDelivery(
      `Bearer ${test.apiKey}`,
      settlementId,
      digest,
    );
    await expect(
      test.service.completeDelivery(`Bearer ${test.apiKey}`, settlementId, digest),
    ).resolves.toEqual(completed);
    await expect(
      test.service.completeDelivery(`Bearer ${test.apiKey}`, settlementId, "d".repeat(64)),
    ).rejects.toMatchObject({ code: "delivery_digest_conflict", status: 409 });
  });

  it("exposes authenticated delivery ledger routes only when enabled", async () => {
    const test = await context({ outcome: "accepted", txid: TXID }, 60, true);
    const settlementId = `ns_${"2".repeat(32)}`;
    test.store.delivery = {
      deliveryId: `nd_${"2".repeat(32)}`,
      settlementId,
      merchantId: "merchant-1",
      status: "delivery_pending",
      attemptCount: 0,
      responseDigest: null,
      retryExpiresAt: new Date(NOW + 60_000),
      receiptId: `nr_${"2".repeat(32)}`,
      receiptToken: "signed-receipt",
    };
    const app = createApp({
      config: test.config,
      database: test.store,
      logger: { info() {}, error() {} },
      quoteService: test.quoteService,
      settlementService: test.service,
    });
    const authorization = { authorization: `Bearer ${test.apiKey}` };

    expect(
      (await app.request(`/v1/x402/settlements/${settlementId}/delivery/claim`, { method: "POST" }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request(`/v1/x402/settlements/${settlementId}/delivery/claim`, {
          method: "POST",
          headers: authorization,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/v1/x402/settlements/${settlementId}/delivery/complete`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ responseDigest: "invalid" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(`/v1/x402/settlements/${settlementId}/delivery/complete`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: JSON.stringify({ responseDigest: "e".repeat(64) }),
        })
      ).status,
    ).toBe(200);
    const openapi = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(openapi.paths).toHaveProperty("/v1/x402/settlements/{id}/delivery/claim");
  });
});
