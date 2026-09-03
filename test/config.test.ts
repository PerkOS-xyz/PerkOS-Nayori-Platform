import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const REQUIRED_ENVIRONMENT: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
};

describe("loadConfig", () => {
  it("keeps OAuth, partner registration and MCP fail-closed", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENVIRONMENT,
        OAUTH_ENABLED: "true",
      }),
    ).toThrow(/OAUTH_SIGNING_PRIVATE_JWK_JSON/);
    expect(() =>
      loadConfig({
        ...REQUIRED_ENVIRONMENT,
        MCP_ENABLED: "true",
      }),
    ).toThrow(/requires OAuth/);
  });

  it("accepts external OAuth without importing its signing key", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      OAUTH_ENABLED: "true",
      OAUTH_MODE: "external",
      MCP_ENABLED: "true",
    });
    expect(config.oauthMode).toBe("external");
    expect(config.oauthIssuerOrigin).toBe("https://oauth.nayori.ai");
    expect(config.oauthResourceOrigin).toBe("https://nayori.ai");
    expect(config.oauthSigningPrivateJwkJson).toBeUndefined();
  });

  it("prevents Platform from owning registration in external OAuth mode", () => {
    expect(() => loadConfig({
      ...REQUIRED_ENVIRONMENT,
      OAUTH_ENABLED: "true",
      OAUTH_MODE: "external",
      PARTNER_REGISTRATION_ENABLED: "true",
    })).toThrow(/owned by the external OAuth service/i);
  });

  it("uses fail-closed foundation defaults", () => {
    const config = loadConfig(REQUIRED_ENVIRONMENT);

    expect(config.stacksNetwork).toBe("testnet");
    expect(config.quoteIssuanceEnabled).toBe(false);
    expect(config.quoteMaxTtlSeconds).toBe(300);
    expect(config.paymentVerificationEnabled).toBe(false);
    expect(config.paymentRateLimitPerMinute).toBe(60);
    expect(config.settlementEnabled).toBe(false);
    expect(config.mainnetSettlementConfirmed).toBe(false);
    expect(config.reconciliationEnabled).toBe(false);
    expect(config.deliveryLedgerEnabled).toBe(false);
    expect(config.publicResourceEnabled).toBe(false);
    expect(config.mppResourceEnabled).toBe(false);
    expect(config.settlementMinConfirmations).toBe(1);
    expect(config.sponsorshipEnabled).toBe(false);
    expect(config.port).toBe(8080);
  });

  it("requires an isolated facilitator credential for the public resource", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENVIRONMENT,
        PUBLIC_RESOURCE_ENABLED: "true",
      }),
    ).toThrow(/merchant API key/i);

    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      SERVICE_ORIGIN: "https://api.nayori.ai",
      PUBLIC_RESOURCE_ENABLED: "true",
      PUBLIC_RESOURCE_URL: "https://nayori.ai/api/v1",
      FACILITATOR_ORIGIN: "https://facilitator.nayori.ai/",
      FACILITATOR_MERCHANT_API_KEY: `ny_mk_${"A".repeat(43)}`,
    });
    expect(config.publicResourceEnabled).toBe(true);
    expect(config.publicResourceUrl).toBe("https://nayori.ai/api/v1");
    expect(config.facilitatorOrigin).toBe("https://facilitator.nayori.ai");
  });

  it("requires an isolated facilitator credential and URL for the MPP resource", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENVIRONMENT,
        MPP_RESOURCE_ENABLED: "true",
      }),
    ).toThrow(/merchant API key/i);

    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      SERVICE_ORIGIN: "https://api.nayori.ai",
      MPP_RESOURCE_ENABLED: "true",
      MPP_RESOURCE_URL: "https://nayori.ai/api/mpp/v1",
      FACILITATOR_ORIGIN: "https://facilitator.nayori.ai/",
      FACILITATOR_MERCHANT_API_KEY: `ny_mk_${"A".repeat(43)}`,
    });
    expect(config.mppResourceEnabled).toBe(true);
    expect(config.mppResourceUrl).toBe("https://nayori.ai/api/mpp/v1");
    expect(config.mppResourceRouteId).toBe("nayori-mpp-usdcx-report");
  });

  it("rejects a facilitator that shares the resource or API origin", () => {
    const base = {
      ...REQUIRED_ENVIRONMENT,
      PUBLIC_RESOURCE_ENABLED: "true",
      FACILITATOR_MERCHANT_API_KEY: `ny_mk_${"A".repeat(43)}`,
    };
    expect(() => loadConfig({
      ...base,
      FACILITATOR_ORIGIN: "https://nayori.ai",
    })).toThrow(/public resource and facilitator/i);
    expect(() => loadConfig({
      ...base,
      FACILITATOR_ORIGIN: "https://api.nayori.ai",
    })).toThrow(/resource server and facilitator/i);

    expect(() => loadConfig({
      ...REQUIRED_ENVIRONMENT,
      SERVICE_ORIGIN: "https://api.nayori.ai",
      MPP_RESOURCE_ENABLED: "true",
      MPP_RESOURCE_URL: "https://facilitator.nayori.ai/mpp/v1",
      FACILITATOR_ORIGIN: "https://facilitator.nayori.ai",
      FACILITATOR_MERCHANT_API_KEY: `ny_mk_${"A".repeat(43)}`,
    })).toThrow(/public resource and facilitator/i);
  });

  it("normalizes the service origin", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      SERVICE_ORIGIN: "https://api.nayori.ai/",
    });

    expect(config.serviceOrigin).toBe("https://api.nayori.ai");
  });

  it("continues to reject sponsorship", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, SPONSORSHIP_ENABLED: "true" }),
    ).toThrow();
  });

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, DATABASE_URL: "https://database.example" }),
    ).toThrow(/postgres/i);
  });

  it("requires a signing key when quote issuance is enabled", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, QUOTE_ISSUANCE_ENABLED: "true" }),
    ).toThrow(/QUOTE_SIGNING_PRIVATE_JWK_JSON/);
  });

  it("accepts explicit quote issuance configuration", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      QUOTE_MAX_TTL_SECONDS: "120",
      QUOTE_RATE_LIMIT_PER_MINUTE: "10",
    });

    expect(config.quoteIssuanceEnabled).toBe(true);
    expect(config.quoteMaxTtlSeconds).toBe(120);
    expect(config.quoteRateLimitPerMinute).toBe(10);
  });

  it("rejects ambiguous quote feature flags", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, QUOTE_ISSUANCE_ENABLED: "yes" }),
    ).toThrow();
  });

  it("requires quote issuance before payment verification", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, PAYMENT_VERIFICATION_ENABLED: "true" }),
    ).toThrow(/requires quote issuance/i);
  });

  it("requires verification and an explicit acknowledgement before mainnet settlement", () => {
    const base = {
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
    };
    expect(() => loadConfig({ ...base, SETTLEMENT_ENABLED: "true" })).toThrow(
      /requires payment verification/i,
    );
    expect(() =>
      loadConfig({
        ...base,
        PAYMENT_VERIFICATION_ENABLED: "true",
        SETTLEMENT_ENABLED: "true",
        STACKS_NETWORK: "mainnet",
        STACKS_API_URL: "https://api.hiro.so",
      }),
    ).toThrow(/CONFIRM_MAINNET_SETTLEMENT=yes/i);
  });

  it("accepts explicitly acknowledged mainnet settlement", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
      CONFIRM_MAINNET_SETTLEMENT: "yes",
      STACKS_NETWORK: "mainnet",
      STACKS_API_URL: "https://api.hiro.so/",
    });

    expect(config.stacksNetwork).toBe("mainnet");
    expect(config.stacksApiUrl).toBe("https://api.hiro.so");
    expect(config.mainnetSettlementConfirmed).toBe(true);
  });

  it("rejects canonical Hiro endpoints from the wrong Stacks network", () => {
    const base = {
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
    };
    expect(() => loadConfig({
      ...base,
      STACKS_NETWORK: "testnet",
      STACKS_API_URL: "https://api.hiro.so",
    })).toThrow(/testnet settlement cannot use.*mainnet/i);
    expect(() => loadConfig({
      ...base,
      CONFIRM_MAINNET_SETTLEMENT: "yes",
      STACKS_NETWORK: "mainnet",
      STACKS_API_URL: "https://api.testnet.hiro.so",
    })).toThrow(/mainnet settlement cannot use.*testnet/i);
  });

  it("accepts explicit testnet verification and settlement", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
      STACKS_NETWORK: "testnet",
      STACKS_API_URL: "https://api.testnet.hiro.so/",
    });

    expect(config.paymentVerificationEnabled).toBe(true);
    expect(config.settlementEnabled).toBe(true);
    expect(config.stacksApiUrl).toBe("https://api.testnet.hiro.so");
  });

  it("requires settlement before reconciliation and reconciliation before delivery", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, RECONCILIATION_ENABLED: "true" }),
    ).toThrow(/requires settlement/i);

    const settlement = {
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
    };
    expect(() =>
      loadConfig({ ...settlement, DELIVERY_LEDGER_ENABLED: "true" }),
    ).toThrow(/requires reconciliation/i);
  });

  it("accepts bounded reconciliation and delivery configuration", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"private":"deployment-secret"}',
      PAYMENT_VERIFICATION_ENABLED: "true",
      SETTLEMENT_ENABLED: "true",
      RECONCILIATION_ENABLED: "true",
      DELIVERY_LEDGER_ENABLED: "true",
      SETTLEMENT_MIN_CONFIRMATIONS: "2",
      RECONCILIATION_BATCH_SIZE: "10",
    });

    expect(config.reconciliationEnabled).toBe(true);
    expect(config.deliveryLedgerEnabled).toBe(true);
    expect(config.settlementMinConfirmations).toBe(2);
    expect(config.reconciliationBatchSize).toBe(10);
  });
});
