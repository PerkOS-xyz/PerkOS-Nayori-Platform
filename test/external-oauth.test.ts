import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, it } from "vitest";

import { MerchantAuthenticationError } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import {
  createExternalOAuthAuthenticator,
  verifyExternalAccessToken,
  type ExternalOAuthClaims,
} from "../src/external-oauth.js";
import type { MerchantRecord } from "../src/merchant.js";

const NOW = 1_800_000_000;
const merchant: MerchantRecord = {
  merchantId: "partner-merchant",
  allowedOrigins: ["https://partner.example"],
  allowedAudiences: ["partner:api"],
  recipientAllowlist: ["ST000000000000000000002AMW42H"],
  routeConfig: { version: 1, routes: {} },
};

function externalConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    OAUTH_ENABLED: "true",
    OAUTH_MODE: "external",
    OAUTH_ISSUER_ORIGIN: "https://oauth.nayori.ai",
    OAUTH_RESOURCE_ORIGIN: "https://nayori.ai",
    OAUTH_JWKS_URI: "https://oauth.nayori.ai/oauth/jwks.json",
  });
}

async function signedToken(audience = "https://nayori.ai") {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA");
  const publicJwk = await exportJWK(publicKey);
  const token = await new SignJWT({
    client_id: `ny_oc_${"A".repeat(24)}`,
    wallet_address: "ST000000000000000000002AMW42H",
    scope: "quotes:create mcp:invoke",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "oauth-test", typ: "at+jwt" })
    .setIssuer("https://oauth.nayori.ai")
    .setAudience(audience)
    .setSubject("partner-merchant")
    .setIssuedAt(NOW)
    .setExpirationTime(NOW + 300)
    .sign(privateKey);
  return {
    token,
    keys: createLocalJWKSet({ keys: [{ ...publicJwk, kid: "oauth-test", alg: "EdDSA" }] }),
  };
}

describe("external OAuth resource verification", () => {
  it("accepts only an EdDSA token for the configured issuer and canonical resource", async () => {
    const config = externalConfig();
    const valid = await signedToken();
    await expect(
      verifyExternalAccessToken(config, valid.token, valid.keys, new Date(NOW * 1_000)),
    ).resolves.toMatchObject({
      merchantId: "partner-merchant",
      scopes: ["quotes:create", "mcp:invoke"],
    });

    const wrongAudience = await signedToken("https://api.nayori.ai");
    await expect(
      verifyExternalAccessToken(config, wrongAudience.token, wrongAudience.keys, new Date(NOW * 1_000)),
    ).rejects.toThrow();
  });

  it("checks the required scope and active Platform merchant after JWT verification", async () => {
    const claims: ExternalOAuthClaims = {
      clientId: `ny_oc_${"A".repeat(24)}`,
      merchantId: merchant.merchantId,
      walletAddress: "ST000000000000000000002AMW42H",
      scopes: ["quotes:create"],
    };
    const store = {
      async findActiveMerchantByApiKeyHash() { return null; },
      async findActiveMerchantById(merchantId: string) {
        return merchantId === merchant.merchantId ? merchant : null;
      },
      async insertIssuedQuote() {},
    };
    const authenticator = createExternalOAuthAuthenticator({
      config: externalConfig(),
      store,
      verifier: async () => claims,
    });
    await expect(authenticator.authenticate("Bearer signed", "quotes:create")).resolves.toEqual(merchant);
    await expect(authenticator.authenticate("Bearer signed", "mcp:invoke"))
      .rejects.toEqual(new MerchantAuthenticationError("insufficient_scope", "mcp:invoke"));
  });
});
