import type { MerchantQuoteStore } from "./database.js";
import {
  hashMerchantApiKey,
  parseBearerApiKey,
  type MerchantRecord,
} from "./merchant.js";

export const oauthScopes = [
  "catalog:read",
  "quotes:create",
  "payments:verify",
  "payments:settle",
  "payments:read",
  "mcp:invoke",
] as const;

export type OAuthScope = (typeof oauthScopes)[number];

export class MerchantAuthenticationError extends Error {
  constructor(
    readonly code: "unauthorized" | "insufficient_scope",
    readonly requiredScope?: OAuthScope,
  ) {
    super(code);
    this.name = "MerchantAuthenticationError";
  }
}

export type MerchantAuthenticator = {
  authenticate(
    authorization: string | undefined,
    requiredScope: OAuthScope,
  ): Promise<MerchantRecord>;
};

export function createApiKeyAuthenticator(store: MerchantQuoteStore): MerchantAuthenticator {
  return {
    async authenticate(authorization) {
      let apiKeyHash: string;
      try {
        apiKeyHash = hashMerchantApiKey(parseBearerApiKey(authorization));
      } catch {
        throw new MerchantAuthenticationError("unauthorized");
      }
      const merchant = await store.findActiveMerchantByApiKeyHash(apiKeyHash);
      if (!merchant) throw new MerchantAuthenticationError("unauthorized");
      return merchant;
    },
  };
}
