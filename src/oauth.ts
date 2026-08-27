import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { verifyMessageSignatureRsv } from "@stacks/encryption";
import { publicKeyToAddressSingleSig } from "@stacks/transactions";
import {
  SignJWT,
  createLocalJWKSet,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { z } from "zod";

import {
  MerchantAuthenticationError,
  createApiKeyAuthenticator,
  oauthScopes,
  type MerchantAuthenticator,
  type OAuthScope,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type {
  MerchantQuoteStore,
  OAuthClientRecord,
  PartnerAuthStore,
  PartnerInvitationRecord,
} from "./database.js";
import type { MerchantRecord } from "./merchant.js";

const invitationTokenPattern = /^ny_pi_[A-Za-z0-9_-]{43}$/;
const clientIdPattern = /^ny_oc_[A-Za-z0-9_-]{24}$/;
const clientSecretPattern = /^ny_cs_[A-Za-z0-9_-]{43}$/;
const challengeIdPattern = /^nc_[0-9a-f]{32}$/;
const hexPublicKeyPattern = /^(?:0x)?(02|03)[0-9a-f]{64}$/i;
const rsvSignaturePattern = /^(?:0x)?[0-9a-f]{130}$/i;

const challengeRequestSchema = z
  .object({
    invitationToken: z.string().regex(invitationTokenPattern),
    walletAddress: z.string().min(38).max(64),
  })
  .strict();

const registrationRequestSchema = z
  .object({
    challengeId: z.string().regex(challengeIdPattern),
    signature: z.string().regex(rsvSignaturePattern),
    publicKey: z.string().regex(hexPublicKeyPattern),
  })
  .strict();

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const privateJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64UrlSchema,
    d: base64UrlSchema,
    kid: z.string().min(1).max(128),
  })
  .passthrough();
const publicJwkSchema = z
  .object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: base64UrlSchema,
    kid: z.string().min(1).max(128),
  })
  .passthrough()
  .refine((value) => !("d" in value), "OAuth public JWKS entries must not contain d.");
const publicJwksSchema = z.object({ keys: z.array(publicJwkSchema).max(16) }).strict();

export class OAuthServiceError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_invitation"
      | "invalid_challenge"
      | "invalid_wallet_signature"
      | "invalid_client"
      | "invalid_scope"
      | "unauthorized"
      | "insufficient_scope",
    readonly publicMessage: string,
    readonly status: 400 | 401 | 403 | 409,
    readonly requiredScope?: OAuthScope,
  ) {
    super(publicMessage);
    this.name = "OAuthServiceError";
  }
}

export type OAuthSigner = {
  readonly publicJwks: { readonly keys: readonly JWK[] };
  sign(input: {
    readonly client: OAuthClientRecord;
    readonly scopes: readonly OAuthScope[];
    readonly issuedAt: number;
    readonly expiresAt: number;
  }): Promise<string>;
  verify(token: string, nowSeconds: number): Promise<{
    readonly clientId: string;
    readonly merchantId: string;
    readonly walletAddress: string;
    readonly scopes: readonly OAuthScope[];
  }>;
};

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${field} must contain valid JSON.`);
  }
}

export async function createOAuthSigner(config: AppConfig): Promise<OAuthSigner> {
  if (!config.oauthEnabled || !config.oauthSigningPrivateJwkJson) {
    throw new Error("OAuth signing cannot start while OAuth is disabled.");
  }
  const privateJwk = privateJwkSchema.parse(
    parseJson(config.oauthSigningPrivateJwkJson, "OAUTH_SIGNING_PRIVATE_JWK_JSON"),
  );
  const previous = publicJwksSchema.parse(
    parseJson(config.oauthPreviousPublicJwksJson, "OAUTH_PREVIOUS_PUBLIC_JWKS_JSON"),
  );
  const publicJwk: JWK = {
    kty: "OKP",
    crv: "Ed25519",
    x: privateJwk.x,
    kid: privateJwk.kid,
    alg: "EdDSA",
    use: "sig",
  };
  const publicJwks = {
    keys: [
      publicJwk,
      ...previous.keys.map((key) => ({ ...key, alg: "EdDSA", use: "sig" })),
    ],
  };
  const privateKey = await importJWK(privateJwk as JWK, "EdDSA");
  const verificationKeys = createLocalJWKSet(publicJwks);
  return {
    publicJwks,
    async sign(input) {
      return new SignJWT({
        client_id: input.client.clientId,
        wallet_address: input.client.walletAddress,
        scope: input.scopes.join(" "),
      })
        .setProtectedHeader({ alg: "EdDSA", kid: privateJwk.kid, typ: "at+jwt" })
        .setIssuer(config.serviceOrigin)
        .setAudience(config.serviceOrigin)
        .setSubject(input.client.merchantId)
        .setJti(randomUUID())
        .setIssuedAt(input.issuedAt)
        .setExpirationTime(input.expiresAt)
        .sign(privateKey);
    },
    async verify(token, nowSeconds) {
      const verified = await jwtVerify(token, verificationKeys, {
        algorithms: ["EdDSA"],
        issuer: config.serviceOrigin,
        audience: config.serviceOrigin,
        currentDate: new Date(nowSeconds * 1_000),
      });
      const scope = typeof verified.payload.scope === "string"
        ? verified.payload.scope.split(" ").filter(Boolean)
        : [];
      if (
        verified.protectedHeader.typ !== "at+jwt" ||
        typeof verified.payload.sub !== "string" ||
        typeof verified.payload.client_id !== "string" ||
        typeof verified.payload.wallet_address !== "string" ||
        scope.some((candidate) => !oauthScopes.includes(candidate as OAuthScope))
      ) {
        throw new Error("OAuth access-token claims are invalid.");
      }
      return {
        clientId: verified.payload.client_id,
        merchantId: verified.payload.sub,
        walletAddress: verified.payload.wallet_address,
        scopes: scope as OAuthScope[],
      };
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeHex(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function safeDigestEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function parseBasicAuthorization(value: string | undefined): { clientId: string; secret: string } {
  if (!value?.startsWith("Basic ")) throw new OAuthServiceError("invalid_client", "Client authentication failed.", 401);
  let decoded: string;
  try {
    decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  } catch {
    throw new OAuthServiceError("invalid_client", "Client authentication failed.", 401);
  }
  const separator = decoded.indexOf(":");
  const clientId = decoded.slice(0, separator);
  const secret = decoded.slice(separator + 1);
  if (separator < 1 || !clientIdPattern.test(clientId) || !clientSecretPattern.test(secret)) {
    throw new OAuthServiceError("invalid_client", "Client authentication failed.", 401);
  }
  return { clientId, secret };
}

function normalizeScopes(value: string | undefined, allowed: readonly string[]): OAuthScope[] {
  const requested = value ? value.split(" ").filter(Boolean) : [...allowed];
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some(
      (scope) => !oauthScopes.includes(scope as OAuthScope) || !allowed.includes(scope),
    )
  ) {
    throw new OAuthServiceError("invalid_scope", "The requested OAuth scope is not allowed.", 400);
  }
  return requested as OAuthScope[];
}

export function generatePartnerInvitationToken(): string {
  return `ny_pi_${randomBytes(32).toString("base64url")}`;
}

export function hashPartnerInvitationToken(token: string): string {
  if (!invitationTokenPattern.test(token)) throw new Error("Partner invitation token has an invalid format.");
  return digest(token);
}

export type OAuthService = MerchantAuthenticator & {
  readonly publicJwks: OAuthSigner["publicJwks"];
  issueChallenge(input: unknown): Promise<{
    readonly challengeId: string;
    readonly message: string;
    readonly expiresAt: string;
    readonly walletAddress: string;
    readonly network: "testnet" | "mainnet";
  }>;
  register(input: unknown): Promise<{
    readonly clientId: string;
    readonly clientSecret: string;
    readonly tokenEndpoint: string;
    readonly scopes: readonly string[];
    readonly walletAddress: string;
  }>;
  issueToken(authorization: string | undefined, form: URLSearchParams): Promise<{
    readonly access_token: string;
    readonly token_type: "Bearer";
    readonly expires_in: number;
    readonly scope: string;
  }>;
};

export function createOAuthService(options: {
  readonly config: AppConfig;
  readonly store: PartnerAuthStore & MerchantQuoteStore;
  readonly signer: OAuthSigner;
  readonly now?: () => number;
}): OAuthService {
  const { config, store, signer } = options;
  const now = options.now ?? (() => Date.now());
  const apiKeys = createApiKeyAuthenticator(store);

  return {
    publicJwks: signer.publicJwks,
    async issueChallenge(input) {
      const parsed = challengeRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new OAuthServiceError("invalid_request", "The partner challenge request is invalid.", 400);
      }
      const current = new Date(now());
      const invitation = await store.findActivePartnerInvitation(
        hashPartnerInvitationToken(parsed.data.invitationToken),
        current,
      );
      if (!invitation) {
        throw new OAuthServiceError("invalid_invitation", "The partner invitation is invalid or expired.", 409);
      }
      const derivedMerchant = await store.findActiveMerchantById(invitation.merchantId);
      if (!derivedMerchant) {
        throw new OAuthServiceError("invalid_invitation", "The partner invitation is invalid or expired.", 409);
      }
      const challengeId = `nc_${randomBytes(16).toString("hex")}`;
      const challengeExpiresAt = new Date(now() + config.partnerChallengeTtlSeconds * 1_000);
      const message = [
        "Nayori partner registration",
        "Version: 1",
        `Origin: ${config.serviceOrigin}`,
        `Network: ${config.stacksNetwork}`,
        `Merchant: ${invitation.merchantId}`,
        `Wallet: ${parsed.data.walletAddress}`,
        `Challenge: ${challengeId}`,
        `Expires at: ${challengeExpiresAt.toISOString()}`,
      ].join("\n");
      await store.insertWalletAuthChallenge({
        ...invitation,
        challengeId,
        walletAddress: parsed.data.walletAddress,
        network: config.stacksNetwork,
        message,
        challengeExpiresAt,
      });
      return {
        challengeId,
        message,
        expiresAt: challengeExpiresAt.toISOString(),
        walletAddress: parsed.data.walletAddress,
        network: config.stacksNetwork,
      };
    },
    async register(input) {
      const parsed = registrationRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new OAuthServiceError("invalid_request", "The partner registration request is invalid.", 400);
      }
      const current = new Date(now());
      const challenge = await store.findActiveWalletAuthChallenge(parsed.data.challengeId, current);
      if (!challenge) {
        throw new OAuthServiceError("invalid_challenge", "The wallet challenge is invalid, expired or consumed.", 409);
      }
      let walletAddress: string;
      let signatureValid = false;
      try {
        const publicKey = normalizeHex(parsed.data.publicKey);
        const signature = normalizeHex(parsed.data.signature);
        walletAddress = publicKeyToAddressSingleSig(publicKey, config.stacksNetwork);
        signatureValid = verifyMessageSignatureRsv({
          message: challenge.message,
          publicKey,
          signature,
        });
      } catch {
        walletAddress = "";
      }
      if (!signatureValid || walletAddress !== challenge.walletAddress) {
        throw new OAuthServiceError("invalid_wallet_signature", "The wallet signature does not authorize this registration.", 401);
      }
      const clientId = `ny_oc_${randomBytes(18).toString("base64url")}`;
      const clientSecret = `ny_cs_${randomBytes(32).toString("base64url")}`;
      const client = await store.consumeChallengeAndCreateOAuthClient({
        challengeId: challenge.challengeId,
        clientId,
        secretDigest: digest(clientSecret),
        usedAt: current,
      });
      if (!client) {
        throw new OAuthServiceError("invalid_challenge", "The wallet challenge is invalid, expired or consumed.", 409);
      }
      return {
        clientId,
        clientSecret,
        tokenEndpoint: `${config.serviceOrigin}/oauth/token`,
        scopes: client.scopes,
        walletAddress: client.walletAddress,
      };
    },
    async issueToken(authorization, form) {
      if (form.get("grant_type") !== "client_credentials") {
        throw new OAuthServiceError("invalid_request", "Only client_credentials is supported.", 400);
      }
      const credentials = parseBasicAuthorization(authorization);
      const client = await store.findActiveOAuthClient(credentials.clientId);
      if (!client || !safeDigestEqual(digest(credentials.secret), client.secretDigest)) {
        throw new OAuthServiceError("invalid_client", "Client authentication failed.", 401);
      }
      const scopes = normalizeScopes(form.get("scope") ?? undefined, client.scopes);
      const issuedAt = Math.floor(now() / 1_000);
      const expiresAt = issuedAt + config.oauthAccessTokenTtlSeconds;
      const accessToken = await signer.sign({ client, scopes, issuedAt, expiresAt });
      await store.recordOAuthTokenIssued(client.clientId, new Date(issuedAt * 1_000));
      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: config.oauthAccessTokenTtlSeconds,
        scope: scopes.join(" "),
      };
    },
    async authenticate(authorization, requiredScope): Promise<MerchantRecord> {
      if (authorization?.startsWith("Bearer ny_mk_")) {
        return apiKeys.authenticate(authorization, requiredScope);
      }
      if (!authorization?.startsWith("Bearer ")) {
        throw new MerchantAuthenticationError("unauthorized");
      }
      let claims;
      try {
        claims = await signer.verify(authorization.slice(7), Math.floor(now() / 1_000));
      } catch {
        throw new MerchantAuthenticationError("unauthorized");
      }
      if (!claims.scopes.includes(requiredScope)) {
        throw new MerchantAuthenticationError("insufficient_scope", requiredScope);
      }
      const client = await store.findActiveOAuthClient(claims.clientId);
      if (
        !client ||
        client.merchantId !== claims.merchantId ||
        client.walletAddress !== claims.walletAddress ||
        !client.scopes.includes(requiredScope)
      ) {
        throw new MerchantAuthenticationError("unauthorized");
      }
      const merchant = await store.findActiveMerchantById(claims.merchantId);
      if (!merchant) throw new MerchantAuthenticationError("unauthorized");
      return merchant;
    },
  };
}

export function createInvitationRecord(input: {
  readonly merchantId: string;
  readonly scopes: readonly OAuthScope[];
  readonly expiresAt: Date;
}): { readonly token: string; readonly record: PartnerInvitationRecord & { readonly tokenDigest: string } } {
  const token = generatePartnerInvitationToken();
  return {
    token,
    record: {
      invitationId: `ni_${randomBytes(16).toString("hex")}`,
      merchantId: input.merchantId,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      tokenDigest: hashPartnerInvitationToken(token),
    },
  };
}
