import {
  buildNayoriMppUnsignedPaymentTransaction,
  createNayoriMppUsdcStacksCredential,
  createNayoriX402PaymentIntent,
  createNayoriX402PaymentRequirements,
  createNayoriX402Quote,
  decodeNayoriMppChallengeHeader,
  decodeNayoriMppReceiptHeader,
  encodeNayoriMppCredentialHeader,
} from "@perkos/agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabaseHealth } from "../src/database.js";
import {
  createFacilitatorClient,
  type FacilitatorClient,
} from "../src/facilitator-client.js";
import type { AppLogger } from "../src/logger.js";
import {
  MPP_CREDENTIAL_HEADER,
  MPP_RECEIPT_HEADER,
  createMppResourceService,
} from "../src/mpp-resource.js";
import { NAYORI_SIGNED_QUOTE_HEADER } from "../src/paid-resource.js";
import type { IssuedQuoteResponse } from "../src/quotes.js";
import type { PublicDelivery, PublicSettlement } from "../src/settlement.js";

const merchantKey = `ny_mk_${"A".repeat(43)}`;
const settlementId = `ns_${"a".repeat(32)}`;
const requestId = "mpp-resource-test-request";
const payer = "ST1THWXQ8368SDN2MJGE4BMDKMCHZ2GSVTSQDA7QF";
const payerPublicKey =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const config = loadConfig({
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
  SERVICE_ORIGIN: "https://api.nayori.ai",
  STACKS_NETWORK: "testnet",
  MPP_RESOURCE_ENABLED: "true",
  MPP_RESOURCE_URL: "https://nayori.ai/api/mpp/v1",
  FACILITATOR_ORIGIN: "https://facilitator.nayori.ai",
  FACILITATOR_MERCHANT_API_KEY: merchantKey,
});

let issuedQuote: IssuedQuoteResponse;
let unsignedTransaction: string;

beforeAll(async () => {
  const now = Math.floor(Date.now() / 1_000);
  const quote = await createNayoriX402Quote({
    quoteId: `nq_${"b".repeat(32)}`,
    merchantId: "nayori-mpp-resource",
    network: "testnet",
    asset: "usdcx",
    amount: 10_000n,
    payTo: payer,
    method: "GET",
    url: config.mppResourceUrl,
    issuedAt: now,
    expiresAt: now + 300,
  });
  const paymentRequirements = await createNayoriX402PaymentRequirements(quote);
  issuedQuote = {
    quote,
    paymentRequirements,
    signedQuote: "signed.mpp.quote.token",
    tokenType: "JWT",
    verification: {
      algorithm: "EdDSA",
      keyId: "quote-key-1",
      jwksUrl: "https://facilitator.nayori.ai/.well-known/jwks.json",
    },
  };
  const intent = await createNayoriX402PaymentIntent({
    quote,
    paymentRequirements,
    request: { method: "GET", url: config.mppResourceUrl },
    payer,
    publicKey: payerPublicKey,
    fee: 300n,
    nonce: 0n,
    nowSeconds: now,
  });
  unsignedTransaction = await buildNayoriMppUnsignedPaymentTransaction(intent);
});

function settlement(status: PublicSettlement["status"]): PublicSettlement {
  const confirmed = status === "confirmed";
  const timestamp = new Date().toISOString();
  return {
    settlementId,
    quoteId: issuedQuote.quote.quoteId,
    network: issuedQuote.quote.network,
    txid: `0x${"c".repeat(64)}`,
    payer,
    status,
    failureReason: null,
    broadcastAttemptedAt: timestamp,
    broadcastAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    confirmed,
    receipt: confirmed ? "settlement.receipt.token" : null,
    deliveryAvailable: confirmed,
    delivery: confirmed
      ? { deliveryId: `nd_${"d".repeat(32)}`, status: "delivery_pending", responseDigest: null }
      : null,
  };
}

function delivery(responseDigest: string | null = null): PublicDelivery {
  return {
    deliveryId: `nd_${"d".repeat(32)}`,
    settlementId,
    status: responseDigest ? "delivered" : "delivering",
    attemptCount: 1,
    responseDigest,
    retryExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    receiptId: `nr_${"e".repeat(32)}`,
    receipt: "delivery.receipt.token",
  };
}

function fakeFacilitator() {
  let currentStatus: PublicSettlement["status"] = "pending";
  let completedDigest: string | null = null;
  const client: FacilitatorClient = {
    async issueQuote() {
      return issuedQuote;
    },
    async settle() {
      throw new Error("x402 settle was not expected");
    },
    async settleMpp() {
      return { settlement: settlement(currentStatus), replayed: false };
    },
    async getSettlement() {
      return settlement(currentStatus);
    },
    async claimDelivery() {
      return delivery(completedDigest);
    },
    async completeDelivery(_id, responseDigest) {
      completedDigest = responseDigest;
      return delivery(responseDigest);
    },
  };
  return {
    client,
    confirm() {
      currentStatus = "confirmed";
    },
    digest() {
      return completedDigest;
    },
  };
}

class FakeDatabase implements DatabaseHealth {
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const logger: AppLogger = { info() {}, error() {} };

describe("public MPP PaymentAuth resource", () => {
  it("issues a USDCx challenge and emits a receipt only after confirmed delivery", async () => {
    const facilitator = fakeFacilitator();
    const service = createMppResourceService({ config, facilitator: facilitator.client });
    const challenge = await service.createChallenge(requestId);
    expect(decodeNayoriMppChallengeHeader(challenge.challenge.wwwAuthenticate)).toMatchObject({
      id: issuedQuote.quote.quoteId,
      method: "usdc",
      intent: "charge",
      header: "Payment-Authorization",
    });
    expect(challenge.challenge.paymentRequest).toMatchObject({
      amount: "10000",
      recipient: payer,
      methodDetails: { type: "stacks" },
    });

    const encodedCredential = encodeNayoriMppCredentialHeader(
      createNayoriMppUsdcStacksCredential({
        challenge: challenge.challenge.challenge,
        source: `stacks:2147483648:${payer}`,
        transaction: unsignedTransaction,
      }),
    );
    await expect(
      service.submit(encodedCredential, issuedQuote.signedQuote, requestId),
    ).resolves.toMatchObject({ state: "pending", settlement: { confirmed: false } });
    expect(facilitator.digest()).toBeNull();

    facilitator.confirm();
    const delivered = await service.retrieve(settlementId, requestId);
    expect(delivered).toMatchObject({
      state: "delivered",
      body: {
        settlement: { confirmed: true, receipt: "delivery.receipt.token" },
        payment: {
          protocol: "mpp-paymentauth",
          method: "usdc",
          intent: "charge",
          type: "stacks",
          asset: "USDCx",
        },
      },
    });
    if (delivered.state !== "delivered") throw new Error("expected delivered resource");
    expect(decodeNayoriMppReceiptHeader(delivered.encodedReceipt)).toMatchObject({
      method: "usdc",
      type: "stacks",
      challengeId: issuedQuote.quote.quoteId,
      reference: `0x${"c".repeat(64)}`,
      status: "success",
    });
    expect(facilitator.digest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exposes the PaymentAuth 402, asynchronous 202 and confirmed 200 flow", async () => {
    const facilitator = fakeFacilitator();
    const service = createMppResourceService({ config, facilitator: facilitator.client });
    const app = createApp({
      config,
      database: new FakeDatabase(),
      logger,
      mppResourceService: service,
    });

    const challengeResponse = await app.request("/mpp/v1");
    expect(challengeResponse.status).toBe(402);
    const authenticate = challengeResponse.headers.get("www-authenticate");
    expect(authenticate).toMatch(/^Payment /);
    expect(decodeNayoriMppChallengeHeader(authenticate!)).toMatchObject({
      header: MPP_CREDENTIAL_HEADER,
    });
    const challengeBody = await challengeResponse.json() as {
      payment: { signedQuote: string };
    };

    const preflight = await app.request("/mpp/v1", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(MPP_CREDENTIAL_HEADER);

    const serviceChallenge = await service.createChallenge(requestId);
    const credential = encodeNayoriMppCredentialHeader(
      createNayoriMppUsdcStacksCredential({
        challenge: serviceChallenge.challenge.challenge,
        source: `stacks:2147483648:${payer}`,
        transaction: unsignedTransaction,
      }),
    );
    const submitted = await app.request("/mpp/v1", {
      headers: {
        [MPP_CREDENTIAL_HEADER]: credential,
        [NAYORI_SIGNED_QUOTE_HEADER]: challengeBody.payment.signedQuote,
      },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("location")).toBe(
      `https://nayori.ai/api/mpp/v1?settlement=${settlementId}`,
    );

    facilitator.confirm();
    const confirmed = await app.request(`/mpp/v1?settlement=${settlementId}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get(MPP_RECEIPT_HEADER)).toBeTruthy();
    expect(await confirmed.json()).toMatchObject({ payment: { protocol: "mpp-paymentauth" } });
  });

  it("returns a fresh Payment challenge when a credential is malformed", async () => {
    const facilitator = fakeFacilitator();
    const app = createApp({
      config,
      database: new FakeDatabase(),
      logger,
      mppResourceService: createMppResourceService({ config, facilitator: facilitator.client }),
    });
    const response = await app.request("/mpp/v1", {
      headers: {
        [MPP_CREDENTIAL_HEADER]: "Payment not-base64",
        [NAYORI_SIGNED_QUOTE_HEADER]: issuedQuote.signedQuote,
      },
    });
    expect(response.status).toBe(402);
    expect(response.headers.get("www-authenticate")).toMatch(/^Payment /);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_payment_credential" },
      payment: { method: "usdc", intent: "charge" },
    });
  });
});

describe("facilitator MPP HTTPS client", () => {
  it("sends MPP settlement to the isolated endpoint with only the merchant bearer", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://facilitator.nayori.ai/v1/mpp/settle");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${merchantKey}`);
      expect(headers.get(MPP_CREDENTIAL_HEADER)).toBeNull();
      return Response.json({ settlement: settlement("pending"), replayed: false }, { status: 202 });
    });
    const client = createFacilitatorClient({
      origin: "https://facilitator.nayori.ai",
      merchantApiKey: merchantKey,
      timeoutMs: 1_000,
      fetch: fetcher,
    });
    await expect(client.settleMpp({ credential: {} }, requestId)).resolves.toMatchObject({
      settlement: { settlementId },
    });
  });
});
