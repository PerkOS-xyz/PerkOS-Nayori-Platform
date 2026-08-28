import { createHash, randomUUID } from "node:crypto";

import {
  createNayoriMppUsdcStacksChallenge,
  NayoriMppVerificationError,
  NayoriX402DirectVerificationError,
  STACKS_X402_NETWORKS,
  verifyNayoriMppUsdcStacksPayment,
  verifyNayoriX402DirectPayment,
  type NayoriMppVerifiedUsdcStacksPayment,
  type NayoriX402ProtectedRequest,
  type NayoriX402VerifiedDirectPayment,
  type PaymentPayload,
  type PaymentRequirements,
} from "@perkos/agent-sdk";
import { z } from "zod";

import type { TransactionBroadcaster } from "./broadcast.js";
import {
  MerchantAuthenticationError,
  createApiKeyAuthenticator,
  type MerchantAuthenticator,
  type OAuthScope,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import {
  SettlementStoreError,
  DeliveryStoreError,
  type DeliveryLedgerRecord,
  type DeliveryLedgerStore,
  type MerchantQuoteStore,
  type SettlementRecord,
  type SettlementStore,
  type StoredQuoteRecord,
} from "./database.js";
import type { MerchantRecord } from "./merchant.js";
import type { QuoteSigner, VerifiedQuoteToken } from "./quote-signing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

const SDK_VERIFIER_VERSION = "@perkos/agent-sdk@0.5.0";
const SDK_NPM_INTEGRITY =
  "sha512-TAVNTpYdlk1w9nsCWfj7cyeS+tk6Jg+DaTGNfj/wQNBOTihRtQZx7TpGdAvLglAW7r2Ed6kOnXXAVr/srw5/0Q==";
const SDK_VERIFIER_CHECKSUM = createHash("sha256")
  .update(SDK_NPM_INTEGRITY, "utf8")
  .digest("hex");

const settlementIdSchema = z.string().regex(/^ns_[0-9a-f]{32}$/);
const responseDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const paymentRequestSchema = z
  .object({
    signedQuote: z.string().min(1).max(16_384),
    paymentRequirements: z.record(z.string(), z.unknown()),
    paymentPayload: z.record(z.string(), z.unknown()),
    request: z
      .object({
        method: z.string().min(1).max(32),
        url: z.url().max(4096),
        body: z.string().max(49_152).optional(),
      })
      .strict(),
  })
  .strict();

type PaymentRequest = z.infer<typeof paymentRequestSchema>;
const mppPaymentRequestSchema = z
  .object({
    signedQuote: z.string().min(1).max(16_384),
    credential: z.record(z.string(), z.unknown()),
    request: z
      .object({
        method: z.string().min(1).max(32),
        url: z.url().max(4096),
        body: z.string().max(49_152).optional(),
      })
      .strict(),
  })
  .strict();

type MppPaymentRequest = z.infer<typeof mppPaymentRequestSchema>;
type SettlementErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

export class SettlementServiceError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status: SettlementErrorStatus,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = "SettlementServiceError";
  }
}

export type PaymentVerification = {
  readonly status: "verified";
  readonly quoteId: string;
  readonly merchantId: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payer: string;
  readonly payTo: string;
  readonly txid: string;
  readonly sponsored: false;
};

export type PublicSettlement = {
  readonly settlementId: string;
  readonly quoteId: string;
  readonly network: string;
  readonly txid: string;
  readonly payer: string;
  readonly status: SettlementRecord["status"];
  readonly failureReason: string | null;
  readonly broadcastAttemptedAt: string | null;
  readonly broadcastAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmed: boolean;
  readonly receipt: string | null;
  readonly deliveryAvailable: boolean;
  readonly delivery: {
    readonly deliveryId: string;
    readonly status: string;
    readonly responseDigest: string | null;
  } | null;
};

export type PublicDelivery = {
  readonly deliveryId: string;
  readonly settlementId: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly responseDigest: string | null;
  readonly retryExpiresAt: string;
  readonly receiptId: string;
  readonly receipt: string;
};

export type SettlementResult = {
  readonly settlement: PublicSettlement;
  readonly replayed: boolean;
};

export type SettlementService = {
  verify(authorization: string | undefined, input: unknown): Promise<PaymentVerification>;
  verifyMpp(authorization: string | undefined, input: unknown): Promise<PaymentVerification>;
  settle(authorization: string | undefined, input: unknown): Promise<SettlementResult>;
  settleMpp(authorization: string | undefined, input: unknown): Promise<SettlementResult>;
  get(
    authorization: string | undefined,
    settlementId: string,
  ): Promise<PublicSettlement>;
  claimDelivery(
    authorization: string | undefined,
    settlementId: string,
  ): Promise<PublicDelivery>;
  completeDelivery(
    authorization: string | undefined,
    settlementId: string,
    responseDigest: string,
  ): Promise<PublicDelivery>;
};

type PaymentVerifier = typeof verifyNayoriX402DirectPayment;
type MppPaymentVerifier = typeof verifyNayoriMppUsdcStacksPayment;

type ValidatedPayment = {
  readonly merchant: MerchantRecord;
  readonly token: VerifiedQuoteToken;
  readonly payment: NayoriX402VerifiedDirectPayment & { readonly transactionId: string };
  readonly signedTokenHash: string;
};

type ValidatedQuote = Pick<ValidatedPayment, "merchant" | "token" | "signedTokenHash">;

function unauthorized(): SettlementServiceError {
  return new SettlementServiceError(
    "unauthorized",
    "A valid merchant bearer credential is required.",
    401,
  );
}

function publicSettlement(record: SettlementRecord, deliveryEnabled: boolean): PublicSettlement {
  const delivery =
    record.deliveryId && record.deliveryStatus
      ? {
          deliveryId: record.deliveryId,
          status: record.deliveryStatus,
          responseDigest: record.responseDigest ?? null,
        }
      : null;
  return {
    settlementId: record.settlementId,
    quoteId: record.quoteId,
    network: record.network,
    txid: record.txid,
    payer: record.payer,
    status: record.status,
    failureReason: record.failureReason,
    broadcastAttemptedAt: record.broadcastAttemptedAt?.toISOString() ?? null,
    broadcastAt: record.broadcastAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    confirmed: record.status === "confirmed",
    receipt: record.receiptToken ?? null,
    deliveryAvailable:
      deliveryEnabled &&
      record.status === "confirmed" &&
      (record.deliveryStatus === "delivery_pending" || record.deliveryStatus === "delivering"),
    delivery,
  };
}

function publicDelivery(record: DeliveryLedgerRecord): PublicDelivery {
  return {
    deliveryId: record.deliveryId,
    settlementId: record.settlementId,
    status: record.status,
    attemptCount: record.attemptCount,
    responseDigest: record.responseDigest,
    retryExpiresAt: record.retryExpiresAt.toISOString(),
    receiptId: record.receiptId,
    receipt: record.receiptToken,
  };
}

function quoteMatchesStored(
  token: VerifiedQuoteToken,
  record: StoredQuoteRecord,
  signedTokenHash: string,
): boolean {
  const quote = token.quote;
  return (
    record.signedTokenHash === signedTokenHash &&
    record.audience === token.audience &&
    record.requestMethod === quote.method &&
    record.canonicalUrl === quote.url &&
    record.bodyHash === quote.bodySha256 &&
    record.network === quote.network &&
    record.assetId === quote.asset &&
    record.amountAtomic === quote.amount &&
    record.payTo === quote.payTo &&
    record.issuedAt.getTime() === quote.issuedAt * 1_000 &&
    record.expiresAt.getTime() === quote.expiresAt * 1_000
  );
}

function rawTransactionHash(transaction: string): string {
  return createHash("sha256").update(Buffer.from(transaction, "hex")).digest("hex");
}

function newSettlementId(): string {
  return `ns_${randomUUID().replaceAll("-", "")}`;
}

export function createSettlementService(options: {
  readonly config: AppConfig;
  readonly store: MerchantQuoteStore & SettlementStore;
  readonly signer: QuoteSigner;
  readonly broadcaster?: TransactionBroadcaster;
  readonly verifier?: PaymentVerifier;
  readonly mppVerifier?: MppPaymentVerifier;
  readonly now?: () => number;
  readonly rateLimiter?: FixedWindowRateLimiter;
  readonly deliveryStore?: DeliveryLedgerStore;
  readonly authenticator?: MerchantAuthenticator;
}): SettlementService {
  const { config, store, signer, broadcaster, deliveryStore } = options;
  if (config.settlementEnabled && !broadcaster) {
    throw new Error("Settlement is enabled without a transaction broadcaster.");
  }
  if (config.deliveryLedgerEnabled && !deliveryStore) {
    throw new Error("The delivery ledger is enabled without a delivery store.");
  }
  const verifier = options.verifier ?? verifyNayoriX402DirectPayment;
  const mppVerifier = options.mppVerifier ?? verifyNayoriMppUsdcStacksPayment;
  const now = options.now ?? (() => Date.now());
  const rateLimiter =
    options.rateLimiter ?? new FixedWindowRateLimiter(config.paymentRateLimitPerMinute, now);
  const authenticator = options.authenticator ?? createApiKeyAuthenticator(store);

  async function authenticate(
    authorization: string | undefined,
    requiredScope: OAuthScope,
  ): Promise<MerchantRecord> {
    let merchant: MerchantRecord;
    try {
      merchant = await authenticator.authenticate(authorization, requiredScope);
    } catch (error) {
      if (error instanceof MerchantAuthenticationError && error.code === "insufficient_scope") {
        throw new SettlementServiceError(
          "insufficient_scope",
          `The bearer credential does not grant ${requiredScope}.`,
          403,
        );
      }
      throw unauthorized();
    }
    const rate = rateLimiter.consume(merchant.merchantId);
    if (!rate.allowed) {
      throw new SettlementServiceError(
        "rate_limited",
        "The merchant payment-operation rate limit was exceeded.",
        429,
        rate.retryAfterSeconds,
      );
    }
    return merchant;
  }

  async function validateQuote(
    merchant: MerchantRecord,
    signedQuote: string,
    allowReserved: boolean,
  ): Promise<ValidatedQuote> {
    const signedTokenHash = createHash("sha256").update(signedQuote, "utf8").digest("hex");
    let token: VerifiedQuoteToken;
    try {
      token = await signer.verify(signedQuote, Math.floor(now() / 1_000));
    } catch {
      throw new SettlementServiceError(
        "invalid_signed_quote",
        "The signed quote is invalid or expired.",
        422,
      );
    }
    if (
      token.merchantId !== merchant.merchantId ||
      token.quote.merchantId !== merchant.merchantId ||
      !merchant.allowedAudiences.includes(token.audience) ||
      token.quote.network !== STACKS_X402_NETWORKS[config.stacksNetwork]
    ) {
      throw new SettlementServiceError(
        "quote_policy_mismatch",
        "The signed quote does not match the authenticated merchant policy.",
        422,
      );
    }
    const stored = await store.findStoredQuote(token.quoteId, merchant.merchantId);
    if (!stored || !quoteMatchesStored(token, stored, signedTokenHash)) {
      throw new SettlementServiceError(
        "quote_record_mismatch",
        "The signed quote does not match an issued merchant quote.",
        422,
      );
    }
    if (
      (stored.status !== "issued" && !(allowReserved && stored.status === "reserved")) ||
      (stored.status === "issued" && stored.expiresAt.getTime() < now())
    ) {
      throw new SettlementServiceError(
        "quote_unavailable",
        "The quote is expired, reserved, consumed or revoked.",
        409,
      );
    }
    return { merchant, token, signedTokenHash };
  }

  async function validate(
    authorization: string | undefined,
    input: unknown,
    allowReserved = false,
    requiredScope: OAuthScope = "payments:verify",
  ): Promise<ValidatedPayment> {
    const merchant = await authenticate(authorization, requiredScope);
    const parsed = paymentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new SettlementServiceError("invalid_request", "The payment request is invalid.", 400);
    }
    const request: PaymentRequest = parsed.data;
    const validatedQuote = await validateQuote(merchant, request.signedQuote, allowReserved);

    let payment: NayoriX402VerifiedDirectPayment;
    try {
      payment = await verifier({
        paymentPayload: request.paymentPayload as unknown as PaymentPayload,
        paymentRequirements: request.paymentRequirements as unknown as PaymentRequirements,
        trustedQuote: validatedQuote.token.quote,
        request: request.request as NayoriX402ProtectedRequest,
        nowSeconds: Math.floor(now() / 1_000),
      });
    } catch (error) {
      const reason =
        error instanceof NayoriX402DirectVerificationError
          ? error.reason
          : "payment_verification_failed";
      throw new SettlementServiceError(
        reason,
        "The payment proof does not satisfy the signed quote.",
        422,
      );
    }
    if (payment.sponsored || !payment.transactionId) {
      throw new SettlementServiceError(
        "sponsorship_not_supported",
        "Sponsored transactions are not supported by this settlement release.",
        422,
      );
    }
    return {
      merchant,
      token: validatedQuote.token,
      payment: payment as NayoriX402VerifiedDirectPayment & { readonly transactionId: string },
      signedTokenHash: validatedQuote.signedTokenHash,
    };
  }

  async function validateMpp(
    authorization: string | undefined,
    input: unknown,
    allowReserved = false,
    requiredScope: OAuthScope = "payments:verify",
  ): Promise<ValidatedPayment> {
    const merchant = await authenticate(authorization, requiredScope);
    const parsed = mppPaymentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new SettlementServiceError("invalid_request", "The MPP payment request is invalid.", 400);
    }
    const request: MppPaymentRequest = parsed.data;
    const validatedQuote = await validateQuote(merchant, request.signedQuote, allowReserved);
    const expectedChallenge = await createNayoriMppUsdcStacksChallenge({
      quote: validatedQuote.token.quote,
      realm: new URL(validatedQuote.token.quote.url).hostname,
    });
    let payment: NayoriMppVerifiedUsdcStacksPayment;
    try {
      payment = await mppVerifier({
        credential: request.credential,
        expectedChallenge: expectedChallenge.challenge,
        trustedQuote: validatedQuote.token.quote,
        request: request.request as NayoriX402ProtectedRequest,
        nowSeconds: Math.floor(now() / 1_000),
      });
    } catch (error) {
      const reason =
        error instanceof NayoriMppVerificationError
          ? error.reason
          : "mpp_payment_verification_failed";
      throw new SettlementServiceError(
        reason,
        "The MPP payment credential does not satisfy the signed quote.",
        422,
      );
    }
    if (payment.sponsored || !payment.transactionId) {
      throw new SettlementServiceError(
        "sponsorship_not_supported",
        "Sponsored transactions are not supported by this settlement release.",
        422,
      );
    }
    return {
      merchant,
      token: validatedQuote.token,
      payment: payment as NayoriMppVerifiedUsdcStacksPayment & {
        readonly transactionId: string;
      },
      signedTokenHash: validatedQuote.signedTokenHash,
    };
  }

  function asPaymentVerification(validated: ValidatedPayment): PaymentVerification {
    return {
      status: "verified",
      quoteId: validated.token.quoteId,
      merchantId: validated.merchant.merchantId,
      network: validated.payment.x402Network,
      asset: validated.payment.asset,
      amount: validated.payment.amount.toString(),
      payer: validated.payment.payer,
      payTo: validated.payment.payTo,
      txid: validated.payment.transactionId,
      sponsored: false,
    };
  }

  async function settleValidated(validated: ValidatedPayment): Promise<SettlementResult> {
    if (!broadcaster) {
      throw new Error("Settlement is not enabled.");
    }
    let reservation;
    try {
      reservation = await store.reserveSettlement({
        settlementId: newSettlementId(),
        quoteId: validated.token.quoteId,
        merchantId: validated.merchant.merchantId,
        network: validated.payment.x402Network,
        txid: validated.payment.transactionId,
        payer: validated.payment.payer,
        rawTxHash: rawTransactionHash(validated.payment.transaction),
        verifierVersion: SDK_VERIFIER_VERSION,
        verifierChecksum: SDK_VERIFIER_CHECKSUM,
        expectedSignedTokenHash: validated.signedTokenHash,
      });
    } catch (error) {
      if (error instanceof SettlementStoreError) {
        throw new SettlementServiceError(
          error.code,
          error.code === "payment_replayed"
            ? "The payment transaction or quote is already reserved."
            : "The quote is no longer available for settlement.",
          409,
        );
      }
      throw error;
    }
    if (!reservation.created) {
      return {
        settlement: publicSettlement(reservation.settlement, config.deliveryLedgerEnabled),
        replayed: true,
      };
    }

    const attemptedAt = new Date(now());
    const outcome = await broadcaster.broadcast(validated.payment.transaction);
    const normalizedOutcome =
      outcome.outcome === "accepted" && outcome.txid !== validated.payment.transactionId
        ? { outcome: "ambiguous" as const, reason: "broadcast_txid_mismatch" }
        : outcome;
    const status =
      normalizedOutcome.outcome === "accepted"
        ? "broadcast"
        : normalizedOutcome.outcome === "rejected"
          ? "failed"
          : "pending";
    const reason = normalizedOutcome.outcome === "accepted" ? null : normalizedOutcome.reason;
    const updated = await store.updateSettlementStatus(
      reservation.settlement.settlementId,
      "validated",
      status,
      reason,
      attemptedAt,
    );
    return {
      settlement: publicSettlement(updated, config.deliveryLedgerEnabled),
      replayed: false,
    };
  }

  return {
    async verify(authorization, input) {
      const validated = await validate(authorization, input);
      return asPaymentVerification(validated);
    },

    async verifyMpp(authorization, input) {
      const validated = await validateMpp(authorization, input);
      return asPaymentVerification(validated);
    },

    async settle(authorization, input) {
      const validated = await validate(authorization, input, true, "payments:settle");
      return settleValidated(validated);
    },

    async settleMpp(authorization, input) {
      const validated = await validateMpp(authorization, input, true, "payments:settle");
      return settleValidated(validated);
    },

    async get(authorization, settlementId) {
      const merchant = await authenticate(authorization, "payments:read");
      if (!settlementIdSchema.safeParse(settlementId).success) {
        throw new SettlementServiceError("settlement_not_found", "Settlement not found.", 404);
      }
      const settlement = await store.findSettlementForMerchant(settlementId, merchant.merchantId);
      if (!settlement) {
        throw new SettlementServiceError("settlement_not_found", "Settlement not found.", 404);
      }
      return publicSettlement(settlement, config.deliveryLedgerEnabled);
    },

    async claimDelivery(authorization, settlementId) {
      const merchant = await authenticate(authorization, "payments:read");
      if (!deliveryStore || !config.deliveryLedgerEnabled) {
        throw new Error("The delivery ledger is not enabled.");
      }
      if (!settlementIdSchema.safeParse(settlementId).success) {
        throw new SettlementServiceError("delivery_not_found", "Delivery not found.", 404);
      }
      try {
        const delivery = await deliveryStore.claimDelivery(
          settlementId,
          merchant.merchantId,
          new Date(now()),
        );
        if (delivery.status === "expired") {
          throw new SettlementServiceError(
            "delivery_expired",
            "The delivery claim window has expired.",
            409,
          );
        }
        return publicDelivery(delivery);
      } catch (error) {
        if (error instanceof SettlementServiceError) throw error;
        if (!(error instanceof DeliveryStoreError)) throw error;
        throw new SettlementServiceError(
          error.code,
          error.code === "delivery_not_found"
            ? "Delivery not found."
            : "The delivery cannot be claimed in its current state.",
          error.code === "delivery_not_found" ? 404 : 409,
        );
      }
    },

    async completeDelivery(authorization, settlementId, responseDigest) {
      const merchant = await authenticate(authorization, "payments:settle");
      if (!deliveryStore || !config.deliveryLedgerEnabled) {
        throw new Error("The delivery ledger is not enabled.");
      }
      if (!settlementIdSchema.safeParse(settlementId).success) {
        throw new SettlementServiceError("delivery_not_found", "Delivery not found.", 404);
      }
      if (!responseDigestSchema.safeParse(responseDigest).success) {
        throw new SettlementServiceError(
          "invalid_request",
          "responseDigest must be a lowercase SHA-256 digest.",
          400,
        );
      }
      try {
        return publicDelivery(
          await deliveryStore.completeDelivery(
            settlementId,
            merchant.merchantId,
            responseDigest,
            new Date(now()),
          ),
        );
      } catch (error) {
        if (!(error instanceof DeliveryStoreError)) throw error;
        throw new SettlementServiceError(
          error.code,
          error.code === "delivery_not_found"
            ? "Delivery not found."
            : "The delivery cannot be completed with this digest or state.",
          error.code === "delivery_not_found" ? 404 : 409,
        );
      }
    },
  };
}
