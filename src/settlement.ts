import { createHash, randomUUID } from "node:crypto";

import {
  NayoriX402DirectVerificationError,
  STACKS_X402_NETWORKS,
  verifyNayoriX402DirectPayment,
  type NayoriX402ProtectedRequest,
  type NayoriX402VerifiedDirectPayment,
  type PaymentPayload,
  type PaymentRequirements,
} from "@perkos/agent-sdk";
import { z } from "zod";

import type { TransactionBroadcaster } from "./broadcast.js";
import type { AppConfig } from "./config.js";
import {
  SettlementStoreError,
  type MerchantQuoteStore,
  type SettlementRecord,
  type SettlementStore,
  type StoredQuoteRecord,
} from "./database.js";
import { hashMerchantApiKey, parseBearerApiKey, type MerchantRecord } from "./merchant.js";
import type { QuoteSigner, VerifiedQuoteToken } from "./quote-signing.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

const SDK_VERIFIER_VERSION = "@perkos/agent-sdk@0.2.0";
const SDK_NPM_INTEGRITY =
  "sha512-u/Zo9lNxJtxNRpI8dSXMBqn86byzWNGxtZRzHBB/6WVt4VMH+i6rzlmyjOgamlC9QoZp3tHx66gHPPdshaijCA==";
const SDK_VERIFIER_CHECKSUM = createHash("sha256")
  .update(SDK_NPM_INTEGRITY, "utf8")
  .digest("hex");

const settlementIdSchema = z.string().regex(/^ns_[0-9a-f]{32}$/);
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
type SettlementErrorStatus = 400 | 401 | 404 | 409 | 422 | 429;

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
  readonly confirmed: false;
  readonly deliveryAvailable: false;
};

export type SettlementResult = {
  readonly settlement: PublicSettlement;
  readonly replayed: boolean;
};

export type SettlementService = {
  verify(authorization: string | undefined, input: unknown): Promise<PaymentVerification>;
  settle(authorization: string | undefined, input: unknown): Promise<SettlementResult>;
  get(
    authorization: string | undefined,
    settlementId: string,
  ): Promise<PublicSettlement>;
};

type PaymentVerifier = typeof verifyNayoriX402DirectPayment;

type ValidatedPayment = {
  readonly merchant: MerchantRecord;
  readonly token: VerifiedQuoteToken;
  readonly payment: NayoriX402VerifiedDirectPayment & { readonly transactionId: string };
  readonly signedTokenHash: string;
};

function unauthorized(): SettlementServiceError {
  return new SettlementServiceError(
    "unauthorized",
    "A valid merchant bearer credential is required.",
    401,
  );
}

function publicSettlement(record: SettlementRecord): PublicSettlement {
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
    confirmed: false,
    deliveryAvailable: false,
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
  readonly now?: () => number;
  readonly rateLimiter?: FixedWindowRateLimiter;
}): SettlementService {
  const { config, store, signer, broadcaster } = options;
  const verifier = options.verifier ?? verifyNayoriX402DirectPayment;
  const now = options.now ?? (() => Date.now());
  const rateLimiter =
    options.rateLimiter ?? new FixedWindowRateLimiter(config.paymentRateLimitPerMinute, now);

  async function authenticate(authorization: string | undefined): Promise<MerchantRecord> {
    let apiKeyHash: string;
    try {
      apiKeyHash = hashMerchantApiKey(parseBearerApiKey(authorization));
    } catch {
      throw unauthorized();
    }
    const merchant = await store.findActiveMerchantByApiKeyHash(apiKeyHash);
    if (!merchant) throw unauthorized();
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

  async function validate(
    authorization: string | undefined,
    input: unknown,
    allowReserved = false,
  ): Promise<ValidatedPayment> {
    const merchant = await authenticate(authorization);
    const parsed = paymentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new SettlementServiceError("invalid_request", "The payment request is invalid.", 400);
    }
    const request: PaymentRequest = parsed.data;
    const signedTokenHash = createHash("sha256")
      .update(request.signedQuote, "utf8")
      .digest("hex");
    let token: VerifiedQuoteToken;
    try {
      token = await signer.verify(request.signedQuote, Math.floor(now() / 1_000));
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

    let payment: NayoriX402VerifiedDirectPayment;
    try {
      payment = await verifier({
        paymentPayload: request.paymentPayload as unknown as PaymentPayload,
        paymentRequirements: request.paymentRequirements as unknown as PaymentRequirements,
        trustedQuote: token.quote,
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
      token,
      payment: payment as NayoriX402VerifiedDirectPayment & { readonly transactionId: string },
      signedTokenHash,
    };
  }

  return {
    async verify(authorization, input) {
      const validated = await validate(authorization, input);
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
    },

    async settle(authorization, input) {
      if (!broadcaster) {
        throw new Error("Settlement is enabled without a transaction broadcaster.");
      }
      const validated = await validate(authorization, input, true);
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
        return { settlement: publicSettlement(reservation.settlement), replayed: true };
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
      const reason =
        normalizedOutcome.outcome === "accepted" ? null : normalizedOutcome.reason;
      const updated = await store.updateSettlementStatus(
        reservation.settlement.settlementId,
        "validated",
        status,
        reason,
        attemptedAt,
      );
      return { settlement: publicSettlement(updated), replayed: false };
    },

    async get(authorization, settlementId) {
      const merchant = await authenticate(authorization);
      if (!settlementIdSchema.safeParse(settlementId).success) {
        throw new SettlementServiceError("settlement_not_found", "Settlement not found.", 404);
      }
      const settlement = await store.findSettlementForMerchant(settlementId, merchant.merchantId);
      if (!settlement) {
        throw new SettlementServiceError("settlement_not_found", "Settlement not found.", 404);
      }
      return publicSettlement(settlement);
    },
  };
}
