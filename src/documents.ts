import { STACKS_X402_NETWORKS } from "@perkos/agent-sdk";

import type { AppConfig } from "./config.js";

export const SERVICE_NAME = "nayori-x402-facilitator";
export const SERVICE_VERSION = "0.4.2";

function serviceStatus(config: AppConfig) {
  if (config.deliveryLedgerEnabled) return "testnet-confirmation-delivery-ledger";
  if (config.reconciliationEnabled) return "testnet-confirmation-ready";
  if (config.settlementEnabled) return "testnet-settlement-broadcast";
  if (config.paymentVerificationEnabled) return "verification-ready";
  if (config.quoteIssuanceEnabled) return "quote-ready";
  return "foundation";
}

export function createSupportedDocument(config: AppConfig) {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    release: config.releaseSha,
    status: serviceStatus(config),
    x402Version: 2,
    quoteIssuanceEnabled: config.quoteIssuanceEnabled,
    paymentVerificationEnabled: config.paymentVerificationEnabled,
    settlementEnabled: config.settlementEnabled,
    confirmationEnabled: config.reconciliationEnabled,
    deliveryLedgerEnabled: config.deliveryLedgerEnabled,
    resourceDeliveryMode: config.deliveryLedgerEnabled ? "merchant-idempotent" : "unavailable",
    sponsorshipEnabled: config.sponsorshipEnabled,
    networks: config.quoteIssuanceEnabled ? [STACKS_X402_NETWORKS[config.stacksNetwork]] : [],
    mechanisms: config.quoteIssuanceEnabled
      ? [
          {
            scheme: "exact",
            assetTransferMethod: "stacks-signed-tx-v1",
            paymentFlow: "upfront",
            assets: ["STX", "sBTC", "USDCx"],
            settlement: config.reconciliationEnabled
              ? "confirmed-after-canonical-depth"
              : config.settlementEnabled
                ? "broadcast-only-confirmation-pending"
                : false,
          },
        ]
      : [],
    roadmap: {
      testNetwork: config.stacksNetwork,
      mechanism: "stacks-signed-tx-v1",
      assets: ["STX", "sBTC", "USDCx"],
    },
  } as const;
}

export function createAgentDocument(config: AppConfig) {
  return {
    schemaVersion: "1.0",
    type: "x402-facilitator",
    name: "Nayori x402 Facilitator",
    provider: { name: "PerkOS", url: "https://perkos.xyz" },
    status: serviceStatus(config),
    homepage: config.serviceOrigin,
    network: config.stacksNetwork,
    authorization: {
      reads: "public discovery only",
      writes: config.deliveryLedgerEnabled
        ? "merchant bearer authentication for quote, settlement status and delivery-ledger operations"
        : config.settlementEnabled
          ? "merchant bearer authentication for quote, verification and testnet broadcast operations"
        : config.paymentVerificationEnabled
          ? "merchant bearer authentication for quote and verify-only operations"
          : config.quoteIssuanceEnabled
            ? "merchant bearer authentication for request-bound quote issuance only"
            : "unavailable while quote issuance is disabled",
      custody: "Nayori does not request or store buyer private keys.",
    },
    discovery: {
      health: `${config.serviceOrigin}/health`,
      readiness: `${config.serviceOrigin}/ready`,
      supported: `${config.serviceOrigin}/supported`,
      x402: `${config.serviceOrigin}/x402.json`,
      openapi: `${config.serviceOrigin}/openapi.json`,
      jwks: config.quoteIssuanceEnabled
        ? `${config.serviceOrigin}/.well-known/jwks.json`
        : null,
      llms: `${config.serviceOrigin}/llms.txt`,
      sdk: "https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK",
    },
    availability: {
      discovery: true,
      quote: config.quoteIssuanceEnabled,
      verify: config.paymentVerificationEnabled,
      settle: config.settlementEnabled,
      confirmation: config.reconciliationEnabled,
      deliveryLedger: config.deliveryLedgerEnabled,
      resourceDelivery: config.deliveryLedgerEnabled ? "merchant-owned" : false,
      sponsorship: false,
    },
  } as const;
}

export function createOpenApiDocument(config: AppConfig) {
  const jsonResponse = {
    "200": {
      description: "Successful response",
      content: { "application/json": { schema: { type: "object" } } },
    },
  };

  const paths: Record<string, unknown> = {
    "/health": { get: { operationId: "getHealth", responses: jsonResponse } },
    "/ready": {
      get: {
        operationId: "getReadiness",
        responses: {
          ...jsonResponse,
          "503": { description: "PostgreSQL is unavailable" },
        },
      },
    },
    "/supported": { get: { operationId: "getSupported", responses: jsonResponse } },
    "/x402.json": { get: { operationId: "getX402Metadata", responses: jsonResponse } },
    "/.well-known/agent.json": {
      get: { operationId: "getAgentManifest", responses: jsonResponse },
    },
    "/llms.txt": {
      get: {
        operationId: "getLlmInstructions",
        responses: {
          "200": {
            description: "Agent-readable service guidance",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/openapi.json": { get: { operationId: "getOpenApi", responses: jsonResponse } },
  };

  if (config.quoteIssuanceEnabled) {
    paths["/.well-known/jwks.json"] = {
      get: { operationId: "getQuoteVerificationKeys", responses: jsonResponse },
    };
    paths["/v1/quotes"] = {
      post: {
        operationId: "issueQuote",
        security: [{ merchantBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "201": { description: "A signed, request-bound quote was issued" },
          "400": { description: "The request is malformed" },
          "401": { description: "Merchant authentication failed" },
          "403": { description: "The request violates merchant route policy" },
          "404": { description: "The configured merchant route does not exist" },
          "429": { description: "The merchant quote rate limit was exceeded" },
        },
      },
    };
  }

  if (config.paymentVerificationEnabled) {
    paths["/v1/x402/verify"] = {
      post: {
        operationId: "verifyDirectPayment",
        security: [{ merchantBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": { description: "The signed transaction satisfies the quote; no broadcast occurred" },
          "401": { description: "Merchant authentication failed" },
          "409": { description: "The quote is unavailable" },
          "422": { description: "Quote or payment verification failed" },
          "429": { description: "The merchant payment-operation rate limit was exceeded" },
        },
      },
    };
  }

  if (config.settlementEnabled) {
    paths["/v1/x402/settle"] = {
      post: {
        operationId: "settleDirectPaymentTestnet",
        security: [{ merchantBearer: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "202": { description: "Reserved and broadcast, or pending reconciliation; not confirmed" },
          "401": { description: "Merchant authentication failed" },
          "409": { description: "Quote or transaction replay" },
          "422": { description: "Verification or definitive broadcast rejection" },
          "429": { description: "The merchant payment-operation rate limit was exceeded" },
        },
      },
    };
    paths["/v1/x402/settlements/{id}"] = {
      get: {
        operationId: "getDirectSettlement",
        security: [{ merchantBearer: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          ...jsonResponse,
          "401": { description: "Authentication failed" },
          "404": { description: "Settlement not found" },
          "429": { description: "The merchant payment-operation rate limit was exceeded" },
        },
      },
    };
  }

  if (config.deliveryLedgerEnabled) {
    paths["/v1/x402/settlements/{id}/delivery/claim"] = {
      post: {
        operationId: "claimConfirmedDelivery",
        security: [{ merchantBearer: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Returns the stable delivery ID and signed confirmation receipt" },
          "401": { description: "Authentication failed" },
          "404": { description: "Delivery not found" },
          "409": { description: "Settlement or delivery is not claimable" },
          "429": { description: "Rate limit exceeded" },
        },
      },
    };
    paths["/v1/x402/settlements/{id}/delivery/complete"] = {
      post: {
        operationId: "completeConfirmedDelivery",
        security: [{ merchantBearer: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": { description: "Records an idempotent delivered-response digest" },
          "400": { description: "The response digest is invalid" },
          "401": { description: "Authentication failed" },
          "404": { description: "Delivery not found" },
          "409": { description: "Delivery state or digest conflicts" },
          "429": { description: "Rate limit exceeded" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Nayori x402 Facilitator API",
      version: SERVICE_VERSION,
      description: config.deliveryLedgerEnabled
        ? "Issues quotes, settles on testnet, reconciles canonical confirmations, signs receipts and exposes a merchant-owned idempotent delivery ledger."
        : config.reconciliationEnabled
          ? "Issues quotes, settles on testnet and reconciles canonical confirmations into signed receipts."
          : config.settlementEnabled
            ? "Issues quotes, verifies standard direct payments and broadcasts each reserved transaction once on testnet. Confirmation and delivery are unavailable."
        : config.paymentVerificationEnabled
          ? "Issues authenticated quotes and verifies payments without broadcasting or delivery."
          : config.quoteIssuanceEnabled
            ? "Issues authenticated request-bound quotes. Payment verification and settlement are disabled."
            : "Foundation release. Quote, verification and settlement operations are disabled.",
    },
    servers: [{ url: config.serviceOrigin }],
    paths,
    components: {
      securitySchemes: {
        merchantBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Nayori merchant API key",
        },
      },
    },
  } as const;
}

export function createLlmsText(config: AppConfig): string {
  return `# Nayori x402 Facilitator

> Private PerkOS infrastructure for request-bound x402 payments on Stacks.

Status: ${serviceStatus(config)}
Origin: ${config.serviceOrigin}
Network target: ${config.stacksNetwork}
Quote issuance enabled: ${config.quoteIssuanceEnabled}
Payment verification enabled: ${config.paymentVerificationEnabled}
Settlement enabled: ${config.settlementEnabled}
Reconciliation enabled: ${config.reconciliationEnabled}
Minimum confirmations: ${config.settlementMinConfirmations}
Delivery ledger enabled: ${config.deliveryLedgerEnabled}
Sponsorship enabled: false

${
  config.deliveryLedgerEnabled
    ? "Authenticated merchants may settle on testnet, receive a signed receipt after canonical confirmation depth and use a stable delivery ID. The merchant resource server performs and deduplicates resource delivery; Nayori does not proxy arbitrary URLs."
    : config.reconciliationEnabled
      ? "Authenticated merchants may settle on testnet and receive a signed receipt only after canonical confirmation depth. Resource delivery and sponsorship are unavailable."
      : config.settlementEnabled
        ? "Authenticated merchants may issue quotes, verify standard direct payments and request one testnet broadcast. Broadcast and pending states are not confirmation. Reconciliation, sponsorship and resource delivery are unavailable."
    : config.paymentVerificationEnabled
      ? "Authenticated merchants may issue quotes and verify standard direct payments. Verification does not broadcast, confirm, settle or deliver a resource."
      : config.quoteIssuanceEnabled
        ? "Authenticated merchants may issue short-lived request-bound quotes. This release does not verify payments, broadcast transactions, settle payments, sponsor fees or deliver paid resources."
    : "This release exposes discovery and health endpoints only. It does not issue quotes, verify payments, broadcast transactions, settle payments, sponsor fees or deliver paid resources."
}
Never treat quote issuance, verify-only or a broadcast response as confirmed payment. Only a
signed receipt emitted after canonical confirmation depth proves settlement. The merchant owns
resource delivery and must deduplicate it by delivery ID.

SDK: https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK
Product: https://nayori.ai
`;
}
