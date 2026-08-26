import type { AppConfig } from "./config.js";

export const SERVICE_NAME = "nayori-x402-facilitator";
export const SERVICE_VERSION = "0.1.0";

export function createSupportedDocument(config: AppConfig) {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    release: config.releaseSha,
    status: "foundation",
    x402Version: 2,
    settlementEnabled: config.settlementEnabled,
    sponsorshipEnabled: config.sponsorshipEnabled,
    networks: [],
    mechanisms: [],
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
    status: "foundation",
    homepage: config.serviceOrigin,
    network: config.stacksNetwork,
    authorization: {
      reads: "public discovery only",
      writes: "unavailable in this foundation release",
      custody: "Nayori does not request or store buyer private keys.",
    },
    discovery: {
      health: `${config.serviceOrigin}/health`,
      readiness: `${config.serviceOrigin}/ready`,
      supported: `${config.serviceOrigin}/supported`,
      x402: `${config.serviceOrigin}/x402.json`,
      openapi: `${config.serviceOrigin}/openapi.json`,
      llms: `${config.serviceOrigin}/llms.txt`,
      sdk: "https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK",
    },
    availability: {
      discovery: true,
      quote: false,
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

  return {
    openapi: "3.1.0",
    info: {
      title: "Nayori x402 Facilitator API",
      version: SERVICE_VERSION,
      description:
        "Foundation release. Payment quote, verification and settlement operations are not enabled.",
    },
    servers: [{ url: config.serviceOrigin }],
    paths: {
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
    },
  } as const;
}

export function createLlmsText(config: AppConfig): string {
  return `# Nayori x402 Facilitator

> Private PerkOS infrastructure for request-bound x402 payments on Stacks.

Status: foundation
Origin: ${config.serviceOrigin}
Network target: ${config.stacksNetwork}
Settlement enabled: false
Sponsorship enabled: false

This release exposes discovery and health endpoints only. It does not issue quotes, verify payments,
broadcast transactions, settle payments, sponsor fees or deliver paid resources. Do not integrate
against placeholder payment behavior; no payment operation is advertised until its security gates
are complete.

SDK: https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK
Product: https://nayori.ai
`;
}
