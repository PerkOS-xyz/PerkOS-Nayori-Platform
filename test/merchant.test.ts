import { describe, expect, it } from "vitest";

import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  merchantProvisioningSchema,
  parseBearerApiKey,
  resolveQuotePolicy,
  type MerchantRecord,
} from "../src/merchant.js";

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

describe("merchant authentication and route policy", () => {
  it("generates and hashes a high-entropy merchant credential", () => {
    const key = generateMerchantApiKey();
    expect(key).toMatch(/^ny_mk_[A-Za-z0-9_-]{43}$/);
    expect(parseBearerApiKey(`Bearer ${key}`)).toBe(key);
    expect(hashMerchantApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMerchantApiKey(key)).toBe(hashMerchantApiKey(key));
  });

  it.each([undefined, "", "Basic abc", "Bearer short", "Bearer ny_mk_bad value"])(
    "rejects malformed authorization %s",
    (authorization) => {
      expect(() => parseBearerApiKey(authorization)).toThrow();
    },
  );

  it("resolves only an exact allowlisted route policy", () => {
    const policy = resolveQuotePolicy(
      merchant,
      {
        routeId: "research",
        request: {
          method: "POST",
          url: "https://merchant.example/v1/research/topic?lang=en",
          body: '{"topic":"stacks"}',
        },
      },
      "testnet",
      300,
    );

    expect(policy.route.asset).toBe("sbtc");
    expect(policy.canonicalUrl).toBe(
      "https://merchant.example/v1/research/topic?lang=en",
    );
  });

  it.each([
    ["GET", "https://merchant.example/v1/research"],
    ["POST", "https://attacker.example/v1/research"],
    ["POST", "https://merchant.example/v1/unrelated"],
  ])("rejects request policy mismatch for %s %s", (method, url) => {
    expect(() =>
      resolveQuotePolicy(
        merchant,
        { routeId: "research", request: { method, url } },
        "testnet",
        300,
      ),
    ).toThrow("route_policy_mismatch");
  });

  it("validates canonical HTTPS provisioning inputs", () => {
    const parsed = merchantProvisioningSchema.parse({
      merchantId: merchant.merchantId,
      allowedOrigins: merchant.allowedOrigins,
      allowedAudiences: merchant.allowedAudiences,
      recipientAllowlist: merchant.recipientAllowlist,
      routeConfig: merchant.routeConfig,
    });
    expect(parsed.status).toBe("active");

    expect(() =>
      merchantProvisioningSchema.parse({
        ...parsed,
        allowedOrigins: ["http://merchant.example"],
      }),
    ).toThrow(/HTTPS/);
  });
});
