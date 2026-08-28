import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyResult,
} from "jose";

import {
  MerchantAuthenticationError,
  createApiKeyAuthenticator,
  oauthScopes,
  type MerchantAuthenticator,
  type OAuthScope,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type { MerchantQuoteStore, PartnerAuthStore } from "./database.js";

const clientIdPattern = /^ny_oc_[A-Za-z0-9_-]{24}$/;
const stacksAddressPattern = /^(?:SP|ST|SM|SN)[0-9A-HJKMNP-TV-Z]{26,62}$/;

export type ExternalOAuthClaims = {
  readonly clientId: string;
  readonly merchantId: string;
  readonly walletAddress: string;
  readonly scopes: readonly OAuthScope[];
};

export type ExternalTokenVerifier = (token: string) => Promise<ExternalOAuthClaims>;

type ExternalOAuthStore = MerchantQuoteStore & Pick<PartnerAuthStore, "findActiveMerchantById">;

function claimsFromVerification(verified: JWTVerifyResult<JWTPayload>): ExternalOAuthClaims {
  const scope = typeof verified.payload.scope === "string"
    ? verified.payload.scope.split(" ").filter(Boolean)
    : [];
  if (
    verified.protectedHeader.typ !== "at+jwt" ||
    typeof verified.payload.sub !== "string" ||
    typeof verified.payload.client_id !== "string" ||
    !clientIdPattern.test(verified.payload.client_id) ||
    typeof verified.payload.wallet_address !== "string" ||
    !stacksAddressPattern.test(verified.payload.wallet_address) ||
    scope.length === 0 ||
    new Set(scope).size !== scope.length ||
    scope.some((candidate) => !oauthScopes.includes(candidate as OAuthScope))
  ) {
    throw new Error("External OAuth access-token claims are invalid.");
  }
  return {
    clientId: verified.payload.client_id,
    merchantId: verified.payload.sub,
    walletAddress: verified.payload.wallet_address,
    scopes: scope as OAuthScope[],
  };
}

export function createRemoteTokenVerifier(config: AppConfig): ExternalTokenVerifier {
  if (!config.oauthEnabled || config.oauthMode !== "external") {
    throw new Error("External OAuth verification cannot start outside external OAuth mode.");
  }
  const keys = createRemoteJWKSet(new URL(config.oauthJwksUri), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  return (token) => verifyExternalAccessToken(config, token, keys);
}

export async function verifyExternalAccessToken(
  config: AppConfig,
  token: string,
  keys: JWTVerifyGetKey,
  currentDate?: Date,
): Promise<ExternalOAuthClaims> {
  return claimsFromVerification(await jwtVerify(token, keys, {
    algorithms: ["EdDSA"],
    issuer: config.oauthIssuerOrigin,
    audience: config.oauthResourceOrigin,
    maxTokenAge: "15 minutes",
    ...(currentDate ? { currentDate } : {}),
  }));
}

export function createExternalOAuthAuthenticator(options: {
  readonly config: AppConfig;
  readonly store: ExternalOAuthStore;
  readonly verifier?: ExternalTokenVerifier;
}): MerchantAuthenticator {
  const { config, store } = options;
  const apiKeys = createApiKeyAuthenticator(store);
  const verify = options.verifier ?? createRemoteTokenVerifier(config);
  return {
    async authenticate(authorization, requiredScope) {
      if (authorization?.startsWith("Bearer ny_mk_")) {
        return apiKeys.authenticate(authorization, requiredScope);
      }
      if (!authorization?.startsWith("Bearer ")) {
        throw new MerchantAuthenticationError("unauthorized");
      }
      let claims: ExternalOAuthClaims;
      try {
        claims = await verify(authorization.slice(7));
      } catch {
        throw new MerchantAuthenticationError("unauthorized");
      }
      if (!claims.scopes.includes(requiredScope)) {
        throw new MerchantAuthenticationError("insufficient_scope", requiredScope);
      }
      const merchant = await store.findActiveMerchantById(claims.merchantId);
      if (!merchant) throw new MerchantAuthenticationError("unauthorized");
      return merchant;
    },
  };
}
