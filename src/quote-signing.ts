import { SignJWT, importJWK, type JWK } from "jose";
import { z } from "zod";

import type { AppConfig } from "./config.js";

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const publicJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64UrlSchema,
    kid: z.string().min(1).max(128),
    alg: z.literal("EdDSA").optional(),
    use: z.literal("sig").optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if ("d" in value) {
      context.addIssue({ code: "custom", message: "Public JWKS entries must not contain d." });
    }
  });

const privateJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64UrlSchema,
    d: base64UrlSchema,
    kid: z.string().min(1).max(128),
    alg: z.literal("EdDSA").optional(),
    use: z.literal("sig").optional(),
  })
  .passthrough();

const publicJwksSchema = z.object({ keys: z.array(publicJwkSchema).max(16) }).strict();

export type PublicJwks = {
  readonly keys: JWK[];
};

export type QuoteSigner = {
  readonly keyId: string;
  readonly publicJwks: PublicJwks;
  sign(input: {
    readonly merchantId: string;
    readonly audience: string;
    readonly quoteId: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly quote: unknown;
  }): Promise<string>;
};

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must contain valid JSON.`);
  }
}

function asPublicJwk(privateJwk: z.infer<typeof privateJwkSchema>): JWK {
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    kid: privateJwk.kid,
    alg: "EdDSA",
    use: "sig",
  };
}

export async function createQuoteSigner(config: AppConfig): Promise<QuoteSigner> {
  if (!config.quoteIssuanceEnabled || !config.quoteSigningPrivateJwkJson) {
    throw new Error("Quote signing cannot start while quote issuance is disabled.");
  }

  const privateJwk = privateJwkSchema.parse(
    parseJson(config.quoteSigningPrivateJwkJson, "QUOTE_SIGNING_PRIVATE_JWK_JSON"),
  );
  const previous = publicJwksSchema.parse(
    parseJson(config.quotePreviousPublicJwksJson, "QUOTE_PREVIOUS_PUBLIC_JWKS_JSON"),
  );
  const publicJwk = asPublicJwk(privateJwk);
  const keyIds = [privateJwk.kid, ...previous.keys.map((key) => key.kid)];
  if (new Set(keyIds).size !== keyIds.length) {
    throw new Error("Quote JWKS key IDs must be unique.");
  }

  const privateKey = await importJWK(privateJwk as JWK, "EdDSA");
  const publicJwks: PublicJwks = {
    keys: [publicJwk, ...previous.keys.map((key) => ({ ...key, alg: "EdDSA", use: "sig" }))],
  };

  return {
    keyId: privateJwk.kid,
    publicJwks,
    async sign(input) {
      return new SignJWT({ quote: input.quote })
        .setProtectedHeader({ alg: "EdDSA", kid: privateJwk.kid, typ: "nayori-quote+jwt" })
        .setIssuer(config.serviceOrigin)
        .setAudience(input.audience)
        .setSubject(input.merchantId)
        .setJti(input.quoteId)
        .setIssuedAt(input.issuedAt)
        .setExpirationTime(input.expiresAt)
        .sign(privateKey);
    },
  };
}
