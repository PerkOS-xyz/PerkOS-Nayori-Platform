import { createHash } from "node:crypto";

import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  STACKS_X402_NETWORKS,
  type PaymentPayload,
  type PaymentRequired,
} from "@perkos/agent-sdk";

import type { AppConfig } from "./config.js";
import {
  FacilitatorClientError,
  type FacilitatorClient,
} from "./facilitator-client.js";
import type { PublicSettlement } from "./settlement.js";
import type { IssuedQuoteResponse } from "./quotes.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
export const NAYORI_SIGNED_QUOTE_HEADER = "X-NAYORI-SIGNED-QUOTE";
export const NAYORI_SETTLEMENT_HEADER = "X-NAYORI-SETTLEMENT-ID";

type ResourceErrorStatus = 400 | 402 | 404 | 409 | 429 | 502 | 503;

export class PaidResourceError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status: ResourceErrorStatus,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = "PaidResourceError";
  }
}

export type PaidResourceChallenge = {
  readonly paymentRequired: PaymentRequired;
  readonly encodedPaymentRequired: string;
};

export type PaidResourcePending = {
  readonly state: "pending";
  readonly settlement: PublicSettlement;
};

export type PaidResourceDelivered = {
  readonly state: "delivered";
  readonly body: Record<string, unknown>;
  readonly encodedPaymentResponse: string;
};

export type PaidResourceResult = PaidResourcePending | PaidResourceDelivered;

export type PaidResourceService = {
  issueQuote(requestId: string): Promise<IssuedQuoteResponse>;
  createChallenge(requestId: string): Promise<PaidResourceChallenge>;
  submit(
    encodedPaymentSignature: string,
    signedQuote: string,
    requestId: string,
  ): Promise<PaidResourceResult>;
  retrieve(settlementId: string, requestId: string): Promise<PaidResourceResult>;
};

function mapFacilitatorError(error: FacilitatorClientError): PaidResourceError {
  if (error.status === 422) {
    return new PaidResourceError(
      error.code,
      "The payment proof does not satisfy the Nayori quote.",
      402,
    );
  }
  if (error.status === 429) {
    return new PaidResourceError(
      error.code,
      error.publicMessage,
      429,
      error.retryAfterSeconds,
    );
  }
  if ([400, 404, 409].includes(error.status)) {
    return new PaidResourceError(error.code, error.publicMessage, error.status as 400 | 404 | 409);
  }
  return new PaidResourceError(
    "facilitator_unavailable",
    "The Nayori facilitator is temporarily unavailable.",
    503,
  );
}

function validateSettlementId(value: string): string {
  if (!/^ns_[0-9a-f]{32}$/.test(value)) {
    throw new PaidResourceError("invalid_settlement_id", "The settlement ID is invalid.", 400);
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
      protocol: "x402",
      version: 2,
      scheme: "exact",
      flow: "upfront",
      assetTransferMethod: "stacks-signed-tx-v1",
      supportedAssets: ["STX", "sBTC", "USDCx"],
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

function pending(settlement: PublicSettlement): PaidResourcePending {
  return { state: "pending", settlement };
}

export function createPaidResourceService(options: {
  readonly config: AppConfig;
  readonly facilitator: FacilitatorClient;
}): PaidResourceService {
  const { config, facilitator } = options;

  async function issueQuote(requestId: string): Promise<IssuedQuoteResponse> {
    try {
      return await facilitator.issueQuote(
        {
          routeId: config.publicResourceRouteId,
          request: { method: "GET", url: config.publicResourceUrl },
        },
        requestId,
      );
    } catch (error) {
      if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
      throw error;
    }
  }

  async function deliver(settlement: PublicSettlement, requestId: string): Promise<PaidResourceDelivered> {
    if (settlement.status !== "confirmed" || !settlement.receipt) {
      throw new PaidResourceError(
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
    const encodedBody = JSON.stringify(body);
    const responseDigest = createHash("sha256").update(encodedBody, "utf8").digest("hex");
    try {
      await facilitator.completeDelivery(settlement.settlementId, responseDigest, requestId);
    } catch (error) {
      if (error instanceof FacilitatorClientError) throw mapFacilitatorError(error);
      throw error;
    }
    return {
      state: "delivered",
      body,
      encodedPaymentResponse: encodePaymentResponseHeader({
        success: true,
        payer: settlement.payer,
        transaction: settlement.txid,
        network: STACKS_X402_NETWORKS[config.stacksNetwork],
      }),
    };
  }

  async function normalizeSettlement(
    settlement: PublicSettlement,
    requestId: string,
  ): Promise<PaidResourceResult> {
    if (settlement.status === "confirmed") return deliver(settlement, requestId);
    if (["failed", "dropped", "reorged"].includes(settlement.status)) {
      throw new PaidResourceError(
        settlement.failureReason ?? "settlement_failed",
        "The Stacks payment did not reach a confirmed settlement.",
        409,
      );
    }
    return pending(settlement);
  }

  return {
    issueQuote,
    async createChallenge(requestId) {
      const issued = await issueQuote(requestId);
      const paymentRequired: PaymentRequired = {
        x402Version: 2,
        error: "Payment is required for the Nayori commerce capability report.",
        resource: {
          url: config.publicResourceUrl,
          description: "Settlement-backed Nayori commerce capability report",
          mimeType: "application/json",
          serviceName: "Nayori",
          tags: ["stacks", "x402", "agent-commerce"],
        },
        accepts: [issued.paymentRequirements],
        extensions: {
          "nayori.stacks.quote": {
            signedQuote: issued.signedQuote,
            quote: issued.quote,
            verification: issued.verification,
            signedQuoteHeader: NAYORI_SIGNED_QUOTE_HEADER,
            settlementMode: "asynchronous-confirmation",
          },
        },
      };
      return {
        paymentRequired,
        encodedPaymentRequired: encodePaymentRequiredHeader(paymentRequired),
      };
    },

    async submit(encodedPaymentSignature, signedQuote, requestId) {
      if (!encodedPaymentSignature || encodedPaymentSignature.length > 32_768) {
        throw new PaidResourceError(
          "invalid_payment_signature",
          "PAYMENT-SIGNATURE is missing or exceeds the accepted size.",
          400,
        );
      }
      let paymentPayload: PaymentPayload;
      try {
        paymentPayload = decodePaymentSignatureHeader(encodedPaymentSignature);
      } catch {
        throw new PaidResourceError(
          "invalid_payment_signature",
          "PAYMENT-SIGNATURE is not a valid x402 v2 payment payload.",
          400,
        );
      }
      if (!signedQuote || signedQuote.length > 16_384) {
        throw new PaidResourceError(
          "invalid_signed_quote",
          `${NAYORI_SIGNED_QUOTE_HEADER} is required and must contain the issued Nayori quote token.`,
          400,
        );
      }
      let result;
      try {
        result = await facilitator.settle(
          {
            signedQuote,
            paymentRequirements: paymentPayload.accepted,
            paymentPayload,
            request: { method: "GET", url: config.publicResourceUrl },
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
