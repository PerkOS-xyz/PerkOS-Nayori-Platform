import { STACKS_X402_NETWORKS } from "@perkos/agent-sdk";

import type { AppConfig } from "./config.js";

export const SERVICE_NAME = "nayori-x402-facilitator";
export const SERVICE_VERSION = "0.2.0";

export function createSupportedDocument(config: AppConfig) {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    release: config.releaseSha,
    status: config.quoteIssuanceEnabled ? "quote-ready" : "foundation",
    x402Version: 2,
    quoteIssuanceEnabled: config.quoteIssuanceEnabled,
    settlementEnabled: config.settlementEnabled,
    sponsorshipEnabled: config.sponsorshipEnabled,
    networks: config.quoteIssuanceEnabled ? [STACKS_X402_NETWORKS[config.stacksNetwork]] : [],
    mechanisms: config.quoteIssuanceEnabled
      ? [
          {
            scheme: "exact",
            assetTransferMethod: "stacks-signed-tx-v1",
            paymentFlow: "upfront",
            assets: ["STX", "sBTC", "USDCx"],
            settlement: false,
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
    status: config.quoteIssuanceEnabled ? "quote-ready" : "foundation",
    homepage: config.serviceOrigin,
    network: config.stacksNetwork,
    authorization: {
      reads: "public discovery only",
      writes: config.quoteIssuanceEnabled
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
      verify: false,
      settle: false,
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

  return {
    openapi: "3.1.0",
    info: {
      title: "Nayori x402 Facilitator API",
      version: SERVICE_VERSION,
      description: config.quoteIssuanceEnabled
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

Status: ${config.quoteIssuanceEnabled ? "quote-ready" : "foundation"}
Origin: ${config.serviceOrigin}
Network target: ${config.stacksNetwork}
Quote issuance enabled: ${config.quoteIssuanceEnabled}
Settlement enabled: false
Sponsorship enabled: false

${
  config.quoteIssuanceEnabled
    ? "Authenticated merchants may issue short-lived request-bound quotes. This release does not verify payments, broadcast transactions, settle payments, sponsor fees or deliver paid resources."
    : "This release exposes discovery and health endpoints only. It does not issue quotes, verify payments, broadcast transactions, settle payments, sponsor fees or deliver paid resources."
}
Do not treat quote issuance as proof of payment. No settlement operation is advertised until its
security gates are complete.

SDK: https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK
Product: https://nayori.ai
`;
}
