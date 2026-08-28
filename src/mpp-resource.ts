import { createHash } from "node:crypto";

import {
  NAYORI_MPP_CREDENTIAL_HEADER,
  createNayoriMppUsdcStacksChallenge,
  createNayoriMppUsdcStacksReceipt,
  decodeNayoriMppCredentialHeader,
  encodeNayoriMppReceiptHeader,
  type NayoriMppChallengeBundle,
} from "@perkos/agent-sdk";

import type { AppConfig } from "./config.js";
import {
  FacilitatorClientError,
  type FacilitatorClient,
} from "./facilitator-client.js";
import {
  NAYORI_SETTLEMENT_HEADER,
  NAYORI_SIGNED_QUOTE_HEADER,
} from "./paid-resource.js";
import type { IssuedQuoteResponse } from "./quotes.js";
import type { PublicSettlement } from "./settlement.js";

export const MPP_CHALLENGE_HEADER = "WWW-Authenticate";
export const MPP_CREDENTIAL_HEADER = NAYORI_MPP_CREDENTIAL_HEADER;
export const MPP_RECEIPT_HEADER = "Payment-Receipt";

type MppResourceErrorStatus = 400 | 402 | 404 | 409 | 429 | 502 | 503;

export class MppResourceError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status: MppResourceErrorStatus,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = "MppResourceError";
  }
}

export type MppResourceChallenge = {
  readonly challenge: NayoriMppChallengeBundle;
  readonly issuedQuote: IssuedQuoteResponse;
  readonly body: Record<string, unknown>;
};

export type MppResourcePending = {
  readonly state: "pending";
  readonly settlement: PublicSettlement;
};

export type MppResourceDelivered = {
  readonly state: "delivered";
  readonly body: Record<string, unknown>;
  readonly encodedReceipt: string;
};

export type MppResourceResult = MppResourcePending | MppResourceDelivered;

export type MppResourceService = {
  createChallenge(requestId: string): Promise<MppResourceChallenge>;
  submit(
    encodedCredential: string,
    signedQuote: string,
    requestId: string,
  ): Promise<MppResourceResult>;
  retrieve(settlementId: string, requestId: string): Promise<MppResourceResult>;
};

function mapFacilitatorError(error: FacilitatorClientError): MppResourceError {
  if (error.status === 422) {
    return new MppResourceError(
      error.code,
      "The MPP payment credential does not satisfy the Nayori quote.",
      402,
    );
  }
  if (error.status === 429) {
    return new MppResourceError(
      error.code,
      error.publicMessage,
      429,
      error.retryAfterSeconds,
    );
  }
  if ([400, 404, 409].includes(error.status)) {
    return new MppResourceError(
      error.code,
      error.publicMessage,
      error.status as 400 | 404 | 409,
    );
  }
  return new MppResourceError(
    "facilitator_unavailable",
    "The Nayori facilitator is temporarily unavailable.",
    503,
  );
}

function validateSettlementId(value: string): string {
  if (!/^ns_[0-9a-f]{32}$/.test(value)) {
    throw new MppResourceError("invalid_settlement_id", "The settlement ID is invalid.", 400);
  }
  return value;
}

function capabilityReport(config: AppConfig, settlement: PublicSettlement, receipt: string) {
  return {
    schemaVersion: "1.0",
    resource: "nayori-commerce-capability-report",
    description: "A settlement-backed machine-readable report of Nayori commerce capabilities.",
    network: settlement.network,
    settlement: {
      settlementId: settlement.settlementId,
      transaction: settlement.txid,
      payer: settlement.payer,
      confirmed: true,
      receipt,
    },
    payment: {
      protocol: "mpp-paymentauth",
      method: "usdc",
      intent: "charge",
      type: "stacks",
      asset: "USDCx",
      sponsorship: false,
      facilitator: config.facilitatorOrigin,
    },
    product: {
      name: "Nayori",
      provider: "PerkOS",
      application: "https://nayori.ai",
      sdk: "https://www.npmjs.com/package/@perkos/agent-sdk",
      documentation: "https://docs.nayori.ai",
    },
  } as const;
}

function pending(settlement: PublicSettlement): MppResourcePending {
  return { state: "pending", settlement };
}

export function createMppResourceService(options: {
  readonly config: AppConfig;
  readonly facilitator: FacilitatorClient;
}): MppResourceService {
  const { config, facilitator } = options;

  async function deliver(
    settlement: PublicSettlement,
    requestId: string,
  ): Promise<MppResourceDelivered> {
    if (settlement.status !== "confirmed" || !settlement.receipt) {
      throw new MppResourceError(
        "settlement_not_confirmed",
        "The payment is not yet confirmed on Stacks.",
        409,
      );
    }
    let delivery;
    try {
      delivery = await facilitator.claimDelivery(settlement.settlementId, requestId);
    } catch (error) {
      if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
      throw error;
    }
    const body = capabilityReport(config, settlement, delivery.receipt);
    const responseDigest = createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex");
    try {
      await facilitator.completeDelivery(settlement.settlementId, responseDigest, requestId);
    } catch (error) {
      if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
      throw error;
    }
    const receipt = createNayoriMppUsdcStacksReceipt({
      challengeId: settlement.quoteId,
      reference: settlement.txid,
      network: config.stacksNetwork,
      settledAt: settlement.updatedAt,
      externalId: settlement.quoteId,
    });
    return {
      state: "delivered",
      body,
      encodedReceipt: encodeNayoriMppReceiptHeader(receipt),
    };
  }

  async function normalizeSettlement(
    settlement: PublicSettlement,
    requestId: string,
  ): Promise<MppResourceResult> {
    if (settlement.status === "confirmed") return deliver(settlement, requestId);
    if (["failed", "dropped", "reorged"].includes(settlement.status)) {
      throw new MppResourceError(
        settlement.failureReason ?? "settlement_failed",
        "The Stacks payment did not reach a confirmed settlement.",
        409,
      );
    }
    return pending(settlement);
  }

  return {
    async createChallenge(requestId) {
      let issuedQuote: IssuedQuoteResponse;
      try {
        issuedQuote = await facilitator.issueQuote(
          {
            routeId: config.mppResourceRouteId,
            request: { method: "GET", url: config.mppResourceUrl },
          },
          requestId,
        );
      } catch (error) {
        if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
        throw error;
      }
      if (issuedQuote.quote.paymentAsset !== "usdcx") {
        throw new MppResourceError(
          "mpp_route_misconfigured",
          "The MPP resource is temporarily unavailable.",
          503,
        );
      }
      const challenge = await createNayoriMppUsdcStacksChallenge({
        quote: issuedQuote.quote,
        realm: new URL(config.mppResourceUrl).hostname,
      });
      return {
        challenge,
        issuedQuote,
        body: {
          type: "https://nayori.ai/problems/payment-required",
          title: "Payment Required",
          status: 402,
          detail: "USDCx payment is required for the Nayori commerce capability report.",
          payment: {
            protocol: "mpp-paymentauth",
            method: "usdc",
            intent: "charge",
            challenge: challenge.challenge,
            request: challenge.paymentRequest,
            credentialHeader: MPP_CREDENTIAL_HEADER,
            receiptHeader: MPP_RECEIPT_HEADER,
            signedQuote: issuedQuote.signedQuote,
            signedQuoteHeader: NAYORI_SIGNED_QUOTE_HEADER,
            verification: issuedQuote.verification,
            settlement: "asynchronous-confirmation",
          },
        },
      };
    },

    async submit(encodedCredential, signedQuote, requestId) {
      if (!encodedCredential || encodedCredential.length > 32_768) {
        throw new MppResourceError(
          "invalid_payment_credential",
          `${MPP_CREDENTIAL_HEADER} is missing or exceeds the accepted size.`,
          402,
        );
      }
      let credential;
      try {
        credential = decodeNayoriMppCredentialHeader(encodedCredential);
      } catch {
        throw new MppResourceError(
          "invalid_payment_credential",
          `${MPP_CREDENTIAL_HEADER} is not a valid MPP Payment credential.`,
          402,
        );
      }
      if (!signedQuote || signedQuote.length > 16_384) {
        throw new MppResourceError(
          "invalid_signed_quote",
          `${NAYORI_SIGNED_QUOTE_HEADER} is required and must contain the issued Nayori quote token.`,
          400,
        );
      }
      let result;
      try {
        result = await facilitator.settleMpp(
          {
            signedQuote,
            credential,
            request: { method: "GET", url: config.mppResourceUrl },
          },
          requestId,
        );
      } catch (error) {
        if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
        throw error;
      }
      return normalizeSettlement(result.settlement, requestId);
    },

    async retrieve(settlementIdInput, requestId) {
      const settlementId = validateSettlementId(settlementIdInput);
      let settlement;
      try {
        settlement = await facilitator.getSettlement(settlementId, requestId);
      } catch (error) {
        if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
        throw error;
      }
      return normalizeSettlement(settlement, requestId);
    },
  };
}

export { NAYORI_SETTLEMENT_HEADER, NAYORI_SIGNED_QUOTE_HEADER };
