import { SignJWT, createLocalJWKSet, importJWK, jwtVerify, type JWK } from "jose";
import { z } from "zod";

import type { NayoriX402Quote } from "@perkos/agent-sdk";

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
const quoteSchema = z
  .object({
    version: z.literal(1),
    quoteId: z.string().min(1).max(128),
    merchantId: z.string().min(1).max(128),
    method: z.string().min(1).max(16),
    url: z.url().max(4096),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    network: z.enum(["stacks:1", "stacks:2147483648"]),
    paymentAsset: z.enum(["stx", "sbtc", "usdcx"]),
    asset: z.string().min(1).max(512),
    amount: z.string().regex(/^[1-9][0-9]*$/),
    payTo: z.string().min(1).max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

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
  signReceipt(input: {
    readonly merchantId: string;
    readonly audience: string;
    readonly receiptId: string;
    readonly issuedAt: number;
    readonly receipt: unknown;
  }): Promise<string>;
  verify(token: string, nowSeconds?: number): Promise<VerifiedQuoteToken>;
};

export type VerifiedQuoteToken = {
  readonly merchantId: string;
  readonly audience: string;
  readonly quoteId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly quote: NayoriX402Quote;
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
  const verificationKeys = createLocalJWKSet(publicJwks);

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
    async signReceipt(input) {
      return new SignJWT({ receipt: input.receipt })
        .setProtectedHeader({
          alg: "EdDSA",
          kid: privateJwk.kid,
          typ: "nayori-settlement-receipt+jwt",
        })
        .setIssuer(config.serviceOrigin)
        .setAudience(input.audience)
        .setSubject(input.merchantId)
        .setJti(input.receiptId)
        .setIssuedAt(input.issuedAt)
        .sign(privateKey);
    },
    async verify(token, nowSeconds = Math.floor(Date.now() / 1_000)) {
      if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
        throw new Error("nowSeconds must be a non-negative safe integer.");
      }
      const verified = await jwtVerify(token, verificationKeys, {
        algorithms: ["EdDSA"],
        issuer: config.serviceOrigin,
        currentDate: new Date(nowSeconds * 1_000),
      });
      if (
        verified.protectedHeader.typ !== "nayori-quote+jwt" ||
        typeof verified.payload.sub !== "string" ||
        typeof verified.payload.jti !== "string" ||
        typeof verified.payload.iat !== "number" ||
        typeof verified.payload.exp !== "number" ||
        typeof verified.payload.aud !== "string"
      ) {
        throw new Error("The signed quote claims are invalid.");
      }
      const quote = quoteSchema.parse(verified.payload.quote);
      if (
        quote.quoteId !== verified.payload.jti ||
        quote.merchantId !== verified.payload.sub ||
        quote.issuedAt !== verified.payload.iat ||
        quote.expiresAt !== verified.payload.exp
      ) {
        throw new Error("The signed quote claims do not match the embedded quote.");
      }
      return {
        merchantId: verified.payload.sub,
        audience: verified.payload.aud,
        quoteId: verified.payload.jti,
        issuedAt: verified.payload.iat,
        expiresAt: verified.payload.exp,
        quote,
      };
    },
  };
}
