import { createHash, randomUUID } from "node:crypto";

import {
  createNayoriX402PaymentRequirements,
  createNayoriX402Quote,
  createNayoriX402QuoteFingerprint,
  NAYORI_X402_DIRECT_ASSET_TRANSFER_METHOD,
  type NayoriX402Quote,
} from "@perkos/agent-sdk";

import type { AppConfig } from "./config.js";
import type { MerchantQuoteStore } from "./database.js";
import {
  MerchantAuthenticationError,
  createApiKeyAuthenticator,
  type MerchantAuthenticator,
} from "./auth.js";
import {
  hashMerchantRouteConfig,
  quoteRequestSchema,
  resolveQuotePolicy,
} from "./merchant.js";
import type { QuoteSigner } from "./quote-signing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

type QuoteErrorStatus = 400 | 401 | 403 | 404 | 429;

export class QuoteServiceError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status: QuoteErrorStatus,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = "QuoteServiceError";
  }
}

export type IssuedQuoteResponse = {
  readonly quote: NayoriX402Quote;
  readonly paymentRequirements: Awaited<ReturnType<typeof createNayoriX402PaymentRequirements>>;
  readonly signedQuote: string;
  readonly tokenType: "JWT";
  readonly verification: {
    readonly algorithm: "EdDSA";
    readonly keyId: string;
    readonly jwksUrl: string;
  };
};

export type IssuedQuoteResult = {
  readonly response: IssuedQuoteResponse;
  readonly merchantId: string;
  readonly routeId: string;
  readonly quoteId: string;
};

export type QuoteService = {
  readonly publicJwks: QuoteSigner["publicJwks"];
  issue(authorization: string | undefined, input: unknown): Promise<IssuedQuoteResult>;
};

function unauthorized(): QuoteServiceError {
  return new QuoteServiceError(
    "unauthorized",
    "A valid merchant bearer credential is required.",
    401,
  );
}

function quoteId(): string {
  return `nq_${randomUUID().replaceAll("-", "")}`;
}

export function createQuoteService(options: {
  readonly config: AppConfig;
  readonly store: MerchantQuoteStore;
  readonly signer: QuoteSigner;
  readonly now?: () => number;
  readonly rateLimiter?: FixedWindowRateLimiter;
  readonly authenticator?: MerchantAuthenticator;
}): QuoteService {
  const { config, store, signer } = options;
  const now = options.now ?? (() => Date.now());
  const rateLimiter =
    options.rateLimiter ?? new FixedWindowRateLimiter(config.quoteRateLimitPerMinute, now);
  const authenticator = options.authenticator ?? createApiKeyAuthenticator(store);

  return {
    publicJwks: signer.publicJwks,
    async issue(authorization, input) {
      let merchant;
      try {
        merchant = await authenticator.authenticate(authorization, "quotes:create");
      } catch (error) {
        if (error instanceof MerchantAuthenticationError && error.code === "insufficient_scope") {
          throw new QuoteServiceError(
            "insufficient_scope",
            "The bearer credential does not grant quotes:create.",
            403,
          );
        }
        throw unauthorized();
      }

      const rate = rateLimiter.consume(merchant.merchantId);
      if (!rate.allowed) {
        throw new QuoteServiceError(
          "rate_limited",
          "The merchant quote rate limit was exceeded.",
          429,
          rate.retryAfterSeconds,
        );
      }

      const parsed = quoteRequestSchema.safeParse(input);
      if (!parsed.success) {
        throw new QuoteServiceError("invalid_request", "The quote request is invalid.", 400);
      }

      let policy: ReturnType<typeof resolveQuotePolicy>;
      try {
        policy = resolveQuotePolicy(
          merchant,
          parsed.data,
          config.stacksNetwork,
          config.quoteMaxTtlSeconds,
        );
      } catch (error) {
        if (error instanceof Error && error.message === "unknown_route") {
          throw new QuoteServiceError("route_not_found", "The merchant route was not found.", 404);
        }
        throw new QuoteServiceError(
          "route_policy_denied",
          "The protected request does not match the merchant route policy.",
          403,
        );
      }

      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + policy.route.ttlSeconds;
      const id = quoteId();
      const quote = await createNayoriX402Quote({
        quoteId: id,
        merchantId: merchant.merchantId,
        method: parsed.data.request.method,
        url: policy.canonicalUrl,
        body: parsed.data.request.body,
        network: policy.route.network,
        asset: policy.route.asset,
        amount: policy.route.amount,
        payTo: policy.route.payTo,
        issuedAt,
        expiresAt,
      });
      const fingerprint = await createNayoriX402QuoteFingerprint(quote);
      const paymentRequirements = await createNayoriX402PaymentRequirements(quote);
      const signedQuote = await signer.sign({
        merchantId: merchant.merchantId,
        audience: policy.route.audience,
        quoteId: id,
        issuedAt,
        expiresAt,
        quote,
      });
      const signedTokenHash = createHash("sha256").update(signedQuote, "utf8").digest("hex");

      await store.insertIssuedQuote({
        quoteId: id,
        merchantId: merchant.merchantId,
        audience: policy.route.audience,
        requestMethod: quote.method,
        canonicalUrl: quote.url,
        bodyHash: quote.bodySha256,
        network: quote.network,
        assetId: quote.asset,
        amountAtomic: quote.amount,
        payTo: quote.payTo,
        fingerprint,
        routeConfigHash: hashMerchantRouteConfig(merchant.routeConfig),
        signedTokenHash,
        issuedAt: new Date(issuedAt * 1000),
        expiresAt: new Date(expiresAt * 1000),
      });

      return {
        merchantId: merchant.merchantId,
        routeId: parsed.data.routeId,
        quoteId: id,
        response: {
          quote,
          paymentRequirements: {
            ...paymentRequirements,
            extra: {
              ...paymentRequirements.extra,
              assetTransferMethod: NAYORI_X402_DIRECT_ASSET_TRANSFER_METHOD,
              quoteFingerprint: fingerprint,
            },
          },
          signedQuote,
          tokenType: "JWT",
          verification: {
            algorithm: "EdDSA",
            keyId: signer.keyId,
            jwksUrl: `${config.serviceOrigin}/.well-known/jwks.json`,
          },
        },
      };
    },
  };
}
