import { exportJWK, generateKeyPair, jwtVerify, createLocalJWKSet } from "jose";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type {
  DatabaseHealth,
  IssuedQuoteRecord,
  MerchantQuoteStore,
} from "../src/database.js";
import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  type MerchantRecord,
} from "../src/merchant.js";
import type { AppLogger, LogFields } from "../src/logger.js";
import { createQuoteSigner } from "../src/quote-signing.js";
import { createQuoteService, type QuoteServiceError } from "../src/quotes.js";
import { FixedWindowRateLimiter } from "../src/rate-limit.js";

const PAY_TO = "ST1THWXQ8368SDN2MJGE4BMDKMCHZ2GSVTSQDA7QF";

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

class FakeStore implements MerchantQuoteStore {
  readonly quotes: IssuedQuoteRecord[] = [];

  constructor(
    private readonly expectedHash: string,
    private readonly record: MerchantRecord | null = merchant,
  ) {}

  async findActiveMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRecord | null> {
    return apiKeyHash === this.expectedHash ? this.record : null;
  }

  async insertIssuedQuote(record: IssuedQuoteRecord): Promise<void> {
    this.quotes.push(record);
  }
}

class FakeDatabase implements DatabaseHealth {
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryLogger implements AppLogger {
  readonly infoEvents: LogFields[] = [];
  readonly errorEvents: LogFields[] = [];
  info(fields: LogFields): void {
    this.infoEvents.push(fields);
  }
  error(fields: LogFields): void {
    this.errorEvents.push(fields);
  }
}

async function testContext(rateLimit = 60) {
  const { privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const privateJwk = {
    ...(await exportJWK(privateKey)),
    kid: "test-active",
    alg: "EdDSA",
    use: "sig",
  };
  const config: AppConfig = loadConfig({
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    NODE_ENV: "test",
    SERVICE_ORIGIN: "https://api.nayori.ai",
    QUOTE_ISSUANCE_ENABLED: "true",
    QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(privateJwk),
    QUOTE_RATE_LIMIT_PER_MINUTE: String(rateLimit),
  });
  const apiKey = generateMerchantApiKey();
  const store = new FakeStore(hashMerchantApiKey(apiKey));
  const signer = await createQuoteSigner(config);
  const service = createQuoteService({
    config,
    store,
    signer,
    now: () => 1_700_000_000_000,
    rateLimiter: new FixedWindowRateLimiter(rateLimit, () => 1_700_000_000_000),
  });
  return { apiKey, config, service, signer, store };
}

const validRequest = {
  routeId: "research",
  request: {
    method: "POST",
    url: "https://merchant.example/v1/research/stacks",
    body: '{"topic":"stacks"}',
  },
};

describe("merchant quote issuance", () => {
  it("issues, signs and persists an SDK-canonical quote", async () => {
    const { apiKey, config, service, signer, store } = await testContext();
    const issued = await service.issue(`Bearer ${apiKey}`, validRequest);
    const verified = await jwtVerify(
      issued.response.signedQuote,
      createLocalJWKSet(signer.publicJwks),
      {
        issuer: config.serviceOrigin,
        audience: "merchant:research",
        currentDate: new Date(1_700_000_010_000),
      },
    );

    expect(issued.response.quote).toMatchObject({
      merchantId: "merchant-1",
      method: "POST",
      network: "stacks:2147483648",
      paymentAsset: "sbtc",
      amount: "1000",
      payTo: PAY_TO,
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_120,
    });
    expect(issued.response.paymentRequirements.extra).toMatchObject({
      assetTransferMethod: "stacks-signed-tx-v1",
      paymentFlow: "upfront",
    });
    expect(verified.payload.quote).toEqual(issued.response.quote);
    expect(store.quotes).toHaveLength(1);
    expect(store.quotes[0]).toMatchObject({
      quoteId: issued.quoteId,
      signedTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      fingerprint: expect.stringMatching(/^ny1_[A-Za-z0-9_-]{27}$/),
      amountAtomic: "1000",
    });
  });

  it("does not reveal credential validity", async () => {
    const { service } = await testContext();
    await expect(service.issue(undefined, validRequest)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
    const unknown = generateMerchantApiKey();
    await expect(service.issue(`Bearer ${unknown}`, validRequest)).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("separates unknown routes from denied route policy", async () => {
    const { apiKey, service } = await testContext();
    await expect(
      service.issue(`Bearer ${apiKey}`, { ...validRequest, routeId: "missing" }),
    ).rejects.toMatchObject({ code: "route_not_found", status: 404 });
    await expect(
      service.issue(`Bearer ${apiKey}`, {
        ...validRequest,
        request: { ...validRequest.request, url: "https://attacker.example/v1/research" },
      }),
    ).rejects.toMatchObject({ code: "route_policy_denied", status: 403 });
  });

  it("rate limits an authenticated merchant", async () => {
    const { apiKey, service } = await testContext(1);
    await service.issue(`Bearer ${apiKey}`, validRequest);
    await expect(service.issue(`Bearer ${apiKey}`, validRequest)).rejects.toEqual(
      expect.objectContaining<Partial<QuoteServiceError>>({
        code: "rate_limited",
        status: 429,
        retryAfterSeconds: 60,
      }),
    );
  });

  it("exposes quote and JWKS routes without exposing settlement", async () => {
    const { apiKey, config, service } = await testContext();
    const logger = new MemoryLogger();
    const app = createApp({ config, database: new FakeDatabase(), logger, quoteService: service });
    const quoteResponse = await app.request("/v1/quotes", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(validRequest),
    });

    expect(quoteResponse.status).toBe(201);
    expect(await (await app.request("/.well-known/jwks.json")).json()).toMatchObject({
      keys: [{ kid: "test-active", kty: "OKP" }],
    });
    const supported = (await (await app.request("/supported")).json()) as {
      quoteIssuanceEnabled: boolean;
      settlementEnabled: boolean;
      networks: string[];
    };
    expect(supported).toMatchObject({
      quoteIssuanceEnabled: true,
      settlementEnabled: false,
      networks: ["stacks:2147483648"],
    });
    expect((await app.request("/v1/x402/settle", { method: "POST" })).status).toBe(404);
    expect(logger.infoEvents).toContainEqual(
      expect.objectContaining({ event: "quote_issued", merchantId: "merchant-1" }),
    );
  });

  it("maps malformed JSON and authentication failures without leaking details", async () => {
    const { config, service } = await testContext();
    const logger = new MemoryLogger();
    const app = createApp({ config, database: new FakeDatabase(), logger, quoteService: service });

    const malformed = await app.request("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_request" } });

    const unauthorized = await app.request("/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validRequest),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe('Bearer realm="nayori-quotes"');
    const body = await unauthorized.text();
    expect(body).toContain("valid merchant bearer credential");
    expect(body).not.toContain("api_key_hash");
  });
});
