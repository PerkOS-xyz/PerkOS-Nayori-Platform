import {
  createNayoriX402DirectPaymentPayload,
  createNayoriX402PaymentRequirements,
  createNayoriX402Quote,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
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
  NAYORI_SIGNED_QUOTE_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createPaidResourceService,
} from "../src/paid-resource.js";
import type { IssuedQuoteResponse } from "../src/quotes.js";
import type { PublicDelivery, PublicSettlement } from "../src/settlement.js";

const merchantKey = `ny_mk_${"A".repeat(43)}`;
const settlementId = `ns_${"a".repeat(32)}`;
const requestId = "resource-test-request";
const config = loadConfig({
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
  SERVICE_ORIGIN: "https://api.nayori.ai",
  STACKS_NETWORK: "testnet",
  PUBLIC_RESOURCE_ENABLED: "true",
  PUBLIC_RESOURCE_URL: "https://nayori.ai/api/v1",
  FACILITATOR_ORIGIN: "https://facilitator.nayori.ai",
  FACILITATOR_MERCHANT_API_KEY: merchantKey,
});

let issuedQuote: IssuedQuoteResponse;
let paymentSignature: string;

beforeAll(async () => {
  const now = Math.floor(Date.now() / 1_000);
  const quote = await createNayoriX402Quote({
    quoteId: `nq_${"b".repeat(32)}`,
    merchantId: "nayori-public-resource",
    network: "testnet",
    asset: "stx",
    amount: 4_000n,
    payTo: "ST000000000000000000002AMW42H",
    method: "GET",
    url: config.publicResourceUrl,
    issuedAt: now,
    expiresAt: now + 300,
  });
  const paymentRequirements = await createNayoriX402PaymentRequirements(quote);
  issuedQuote = {
    quote,
    paymentRequirements,
    signedQuote: "signed.quote.token",
    tokenType: "JWT",
    verification: {
      algorithm: "EdDSA",
      keyId: "quote-key-1",
      jwksUrl: "https://facilitator.nayori.ai/.well-known/jwks.json",
    },
  };
  paymentSignature = encodePaymentSignatureHeader(
    createNayoriX402DirectPaymentPayload({
      paymentRequirements,
      transaction: "deadbeef",
    }),
  );
});

function settlement(status: PublicSettlement["status"]): PublicSettlement {
  const confirmed = status === "confirmed";
  return {
    settlementId,
    quoteId: issuedQuote.quote.quoteId,
    network: issuedQuote.quote.network,
    txid: `0x${"c".repeat(64)}`,
    payer: "ST000000000000000000002AMW42H",
    status,
    failureReason: null,
    broadcastAttemptedAt: new Date().toISOString(),
    broadcastAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    async issueQuote(input, observedRequestId) {
      expect(input).toEqual({
        routeId: "nayori-capability-report",
        request: { method: "GET", url: "https://nayori.ai/api/v1" },
      });
      expect(observedRequestId).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
      return issuedQuote;
    },
    async settle() {
      return { settlement: settlement(currentStatus), replayed: false };
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

describe("public x402 resource", () => {
  it("issues a standard challenge and delivers only after facilitator confirmation", async () => {
    const facilitator = fakeFacilitator();
    const service = createPaidResourceService({ config, facilitator: facilitator.client });

    await expect(service.issueQuote(requestId)).resolves.toEqual(issuedQuote);
    const challenge = await service.createChallenge(requestId);
    const decoded = decodePaymentRequiredHeader(challenge.encodedPaymentRequired);
    expect(decoded).toMatchObject({
      x402Version: 2,
      resource: { url: "https://nayori.ai/api/v1" },
      accepts: [{ network: "stacks:2147483648", asset: "STX" }],
      extensions: {
        "nayori.stacks.quote": {
          signedQuote: "signed.quote.token",
          signedQuoteHeader: NAYORI_SIGNED_QUOTE_HEADER,
          settlementMode: "asynchronous-confirmation",
        },
      },
    });

    const pending = await service.submit(paymentSignature, issuedQuote.signedQuote, requestId);
    expect(pending).toMatchObject({ state: "pending", settlement: { confirmed: false } });
    expect(facilitator.digest()).toBeNull();

    facilitator.confirm();
    const delivered = await service.retrieve(settlementId, requestId);
    expect(delivered).toMatchObject({
      state: "delivered",
      body: {
        resource: "nayori-commerce-capability-report",
        settlement: { confirmed: true, receipt: "delivery.receipt.token" },
        payment: { protocol: "x402", assetTransferMethod: "stacks-signed-tx-v1" },
      },
    });
    expect(facilitator.digest()).toMatch(/^[0-9a-f]{64}$/);
    if (delivered.state !== "delivered") throw new Error("expected delivered resource");
    expect(decodePaymentResponseHeader(delivered.encodedPaymentResponse)).toMatchObject({
      success: true,
      network: "stacks:2147483648",
      transaction: `0x${"c".repeat(64)}`,
    });
  });

  it("exposes 402, asynchronous 202 and confirmed 200 over GET /v1", async () => {
    const facilitator = fakeFacilitator();
    const service = createPaidResourceService({ config, facilitator: facilitator.client });
    const app = createApp({
      config,
      database: new FakeDatabase(),
      logger,
      paidResourceService: service,
    });

    const challenge = await app.request("/v1");
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(challenge.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await app.request("/v1", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      PAYMENT_SIGNATURE_HEADER,
    );

    const submitted = await app.request("/v1", {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: paymentSignature,
        [NAYORI_SIGNED_QUOTE_HEADER]: issuedQuote.signedQuote,
      },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.headers.get("location")).toBe(
      `https://nayori.ai/api/v1?settlement=${settlementId}`,
    );
    expect(submitted.headers.get("retry-after")).toBe("5");

    facilitator.confirm();
    const confirmed = await app.request(`/v1?settlement=${settlementId}`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy();
    expect(await confirmed.json()).toMatchObject({ settlement: { confirmed: true } });
  });
});

describe("facilitator HTTPS client", () => {
  it("sends only the configured merchant credential to the isolated host", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://facilitator.nayori.ai/v1/quotes");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${merchantKey}`);
      expect(headers.get("x-request-id")).toBe(requestId);
      return Response.json(issuedQuote, { status: 201 });
    });
    const client = createFacilitatorClient({
      origin: "https://facilitator.nayori.ai/",
      merchantApiKey: merchantKey,
      timeoutMs: 1_000,
      fetch: fetcher,
    });

    await expect(client.issueQuote({ routeId: "report" }, requestId)).resolves.toEqual(issuedQuote);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
