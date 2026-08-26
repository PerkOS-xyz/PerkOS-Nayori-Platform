import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createQuoteSigner } from "../src/quote-signing.js";

async function signingJwk(keyId: string) {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid: keyId, alg: "EdDSA", use: "sig" },
    publicJwk: { ...(await exportJWK(publicKey)), kid: keyId, alg: "EdDSA", use: "sig" },
  };
}

describe("quote signing", () => {
  it("signs publicly verifiable Ed25519 quote tokens", async () => {
    const active = await signingJwk("active-2026-08");
    const config = loadConfig({
      DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
      NODE_ENV: "test",
      SERVICE_ORIGIN: "https://api.nayori.ai",
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(active.privateJwk),
    });
    const signer = await createQuoteSigner(config);
    const token = await signer.sign({
      merchantId: "merchant-1",
      audience: "merchant:research",
      quoteId: "quote-1",
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_120,
      quote: { quoteId: "quote-1" },
    });
    const verification = await jwtVerify(
      token,
      createLocalJWKSet(signer.publicJwks),
      {
        issuer: "https://api.nayori.ai",
        audience: "merchant:research",
        currentDate: new Date(1_700_000_010_000),
      },
    );

    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: "EdDSA",
      kid: "active-2026-08",
      typ: "nayori-quote+jwt",
    });
    expect(verification.payload).toMatchObject({
      sub: "merchant-1",
      jti: "quote-1",
      quote: { quoteId: "quote-1" },
    });
    expect(JSON.stringify(signer.publicJwks)).not.toContain('"d"');
  });

  it("retains prior public keys during rotation", async () => {
    const active = await signingJwk("active");
    const previous = await signingJwk("previous");
    const signer = await createQuoteSigner(
      loadConfig({
        DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
        NODE_ENV: "test",
        QUOTE_ISSUANCE_ENABLED: "true",
        QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(active.privateJwk),
        QUOTE_PREVIOUS_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [previous.publicJwk] }),
      }),
    );

    expect(signer.publicJwks.keys.map((key) => key.kid)).toEqual(["active", "previous"]);
  });

  it("rejects duplicate IDs and private previous keys", async () => {
    const active = await signingJwk("duplicate");
    await expect(
      createQuoteSigner(
        loadConfig({
          DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
          NODE_ENV: "test",
          QUOTE_ISSUANCE_ENABLED: "true",
          QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(active.privateJwk),
          QUOTE_PREVIOUS_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [active.publicJwk] }),
        }),
      ),
    ).rejects.toThrow(/unique/);

    await expect(
      createQuoteSigner(
        loadConfig({
          DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
          NODE_ENV: "test",
          QUOTE_ISSUANCE_ENABLED: "true",
          QUOTE_SIGNING_PRIVATE_JWK_JSON: JSON.stringify(active.privateJwk),
          QUOTE_PREVIOUS_PUBLIC_JWKS_JSON: JSON.stringify({ keys: [active.privateJwk] }),
        }),
      ),
    ).rejects.toThrow(/must not contain d/);
  });
});
