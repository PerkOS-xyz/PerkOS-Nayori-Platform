import { STACKS_X402_NETWORKS } from "@perkos/agent-sdk";

import { oauthScopes } from "./auth.js";
import type { AppConfig } from "./config.js";

export const SERVICE_NAME = "nayori-x402-facilitator";
export const SERVICE_VERSION = "0.6.0";

function oauthIssuer(config: AppConfig): string {
  return config.oauthMode === "external" ? config.oauthIssuerOrigin : config.serviceOrigin;
}

function oauthResource(config: AppConfig): string {
  return config.oauthMode === "external" ? config.oauthResourceOrigin : config.serviceOrigin;
}

function oauthJwks(config: AppConfig): string {
  return config.oauthMode === "external" ? config.oauthJwksUri : `${config.serviceOrigin}/oauth/jwks.json`;
}

function serviceStatus(config: AppConfig) {
  if (config.publicResourceEnabled) return "public-x402-resource";
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
    oauthEnabled: config.oauthEnabled,
    oauthMode: config.oauthEnabled ? config.oauthMode : "disabled",
    partnerRegistrationEnabled: config.partnerRegistrationEnabled,
    mcpEnabled: config.mcpEnabled,
    publicResourceEnabled: config.publicResourceEnabled,
    publicResource: config.publicResourceEnabled
      ? {
          url: config.publicResourceUrl,
          facilitator: config.facilitatorOrigin,
          settlement: "asynchronous-confirmation",
        }
      : null,
    resourceDeliveryMode: config.publicResourceEnabled
      ? "facilitator-backed-idempotent"
      : config.deliveryLedgerEnabled
        ? "merchant-idempotent"
        : "unavailable",
    sponsorshipEnabled: config.sponsorshipEnabled,
    networks: config.quoteIssuanceEnabled || config.publicResourceEnabled
      ? [STACKS_X402_NETWORKS[config.stacksNetwork]]
      : [],
    mechanisms: config.quoteIssuanceEnabled || config.publicResourceEnabled
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
      oauthAuthorizationServer: config.oauthEnabled
        ? `${oauthIssuer(config)}/.well-known/oauth-authorization-server`
        : null,
      oauthProtectedResource: config.oauthEnabled
        ? `${oauthResource(config)}/.well-known/oauth-protected-resource`
        : null,
      authGuide: config.oauthEnabled ? `${oauthResource(config)}/auth.md` : null,
      mcpServerCard: config.mcpEnabled
        ? `${config.serviceOrigin}/.well-known/mcp/server-card.json`
        : null,
      paidResource: config.publicResourceEnabled ? config.publicResourceUrl : null,
      facilitator: config.publicResourceEnabled ? config.facilitatorOrigin : null,
      sdk: "https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK",
    },
    availability: {
      discovery: true,
      quote: config.quoteIssuanceEnabled,
      verify: config.paymentVerificationEnabled,
      settle: config.settlementEnabled,
      confirmation: config.reconciliationEnabled,
      deliveryLedger: config.deliveryLedgerEnabled,
      resourceDelivery: config.publicResourceEnabled
        ? "facilitator-backed"
        : config.deliveryLedgerEnabled
          ? "merchant-owned"
          : false,
      sponsorship: false,
      oauth: config.oauthEnabled,
      partnerRegistration: config.partnerRegistrationEnabled,
      mcp: config.mcpEnabled,
      publicPaidResource: config.publicResourceEnabled,
    },
  } as const;
}

export function createOAuthAuthorizationServerMetadata(config: AppConfig) {
  const issuer = oauthIssuer(config);
  return {
    issuer,
    token_endpoint: `${issuer}/oauth/token`,
    jwks_uri: oauthJwks(config),
    grant_types_supported: ["client_credentials"],
    response_types_supported: [],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    scopes_supported: oauthScopes,
    service_documentation: `${oauthResource(config)}/auth.md`,
  } as const;
}

export function createOAuthProtectedResourceMetadata(config: AppConfig) {
  return {
    resource: oauthResource(config),
    authorization_servers: [oauthIssuer(config)],
    jwks_uri: oauthJwks(config),
    scopes_supported: oauthScopes,
    bearer_methods_supported: ["header"],
    resource_documentation: `${oauthResource(config)}/auth.md`,
  } as const;
}

export function createAuthMarkdown(config: AppConfig): string {
  return `# Auth.md — Nayori agent authentication

Nayori supports OAuth 2.0 client credentials for invited partners and existing merchant API keys
for backward compatibility. Partner enrollment is bound to a Stacks wallet by an exact plaintext
message signed in Leather. The API never requests or stores a wallet private key.

## Discovery

- Authorization server: ${oauthIssuer(config)}/.well-known/oauth-authorization-server
- Protected resource: ${oauthResource(config)}/.well-known/oauth-protected-resource
- Token endpoint: ${oauthIssuer(config)}/oauth/token
- OAuth JWKS: ${oauthJwks(config)}

OAuth authorizes API and MCP access. A buyer still signs each STX, sBTC or USDCx payment
transaction separately in its wallet; an OAuth token cannot sign or approve a payment.

Supported grant: client_credentials. Supported client authentication: client_secret_basic.
Access tokens are short-lived EdDSA JWTs and must be sent in the Authorization bearer header.
`;
}

export function createMcpServerCard(config: AppConfig) {
  return {
    schemaVersion: "1.0",
    name: "Nayori x402 MCP Server",
    serverInfo: { name: "nayori-x402", version: SERVICE_VERSION },
    description: "Experimental authenticated MCP access to Nayori x402 discovery, quotes and settlement status.",
    status: "experimental",
    server: {
      url: `${config.serviceOrigin}/mcp`,
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
    },
    authentication: {
      type: "oauth2",
      protectedResourceMetadata: `${oauthResource(config)}/.well-known/oauth-protected-resource`,
      requiredScopes: ["mcp:invoke"],
    },
    capabilities: { tools: true, prompts: false, resources: false },
    documentation: `${oauthResource(config)}/auth.md`,
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

  if (config.publicResourceEnabled) {
    paths["/v1"] = {
      get: {
        operationId: "getPaidNayoriCapabilityReport",
        summary: "Purchase or retrieve the Nayori commerce capability report with x402 on Stacks",
        parameters: [
          {
            name: "settlement",
            in: "query",
            required: false,
            schema: { type: "string", pattern: "^ns_[0-9a-f]{32}$" },
            description: "Poll a previously submitted asynchronous Stacks settlement.",
          },
        ],
        responses: {
          "200": {
            description: "Confirmed settlement and idempotently delivered capability report",
            headers: {
              "PAYMENT-RESPONSE": { description: "Base64 x402 v2 settlement response" },
            },
          },
          "202": {
            description: "The signed Stacks transaction is awaiting canonical confirmation",
            headers: {
              Location: { description: "Polling URL for this settlement" },
              "Retry-After": { description: "Suggested polling delay in seconds" },
              "X-NAYORI-SETTLEMENT-ID": { description: "Nayori settlement identifier" },
            },
          },
          "402": {
            description: "A wallet-approved x402 payment is required",
            headers: {
              "PAYMENT-REQUIRED": { description: "Base64 x402 v2 payment requirements" },
            },
          },
          "409": { description: "The settlement failed or is not deliverable" },
          "503": { description: "The isolated facilitator is unavailable" },
        },
      },
    };
  }

  if (config.oauthEnabled) {
    paths["/.well-known/oauth-authorization-server"] = {
      get: { operationId: "getOAuthAuthorizationServerMetadata", responses: jsonResponse },
    };
    paths["/.well-known/oauth-protected-resource"] = {
      get: { operationId: "getOAuthProtectedResourceMetadata", responses: jsonResponse },
    };
    paths["/oauth/jwks.json"] = {
      get: { operationId: "getOAuthVerificationKeys", responses: jsonResponse },
    };
    if (config.oauthMode === "embedded") {
      paths["/oauth/token"] = {
        post: {
          operationId: "issueOAuthClientCredentialsToken",
          security: [{ oauthClientBasic: [] }],
          responses: {
            "200": { description: "A short-lived scoped access token was issued" },
            "400": { description: "Grant or scope request is invalid" },
            "401": { description: "Client authentication failed" },
          },
        },
      };
    }
  }

  if (config.partnerRegistrationEnabled) {
    paths["/v1/partners/challenges"] = {
      post: { operationId: "createPartnerWalletChallenge", responses: { "201": { description: "Wallet-signing challenge created" } } },
    };
    paths["/v1/partners/register"] = {
      post: { operationId: "registerWalletLinkedOAuthClient", responses: { "201": { description: "OAuth client created; secret returned once" } } },
    };
  }

  if (config.mcpEnabled) {
    paths["/.well-known/mcp/server-card.json"] = {
      get: { operationId: "getMcpServerCard", responses: jsonResponse },
    };
    paths["/mcp"] = {
      post: {
        operationId: "invokeMcpStreamableHttp",
        security: [{ oauthBearer: ["mcp:invoke"] }],
        responses: { ...jsonResponse, "401": { description: "OAuth token required" }, "403": { description: "mcp:invoke scope required" } },
      },
    };
  }

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
      description: config.publicResourceEnabled
        ? "Exposes a public same-origin x402 resource backed by an isolated Stacks facilitator."
        : config.deliveryLedgerEnabled
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
        oauthBearer: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: `${oauthIssuer(config)}/oauth/token`,
              scopes: Object.fromEntries(oauthScopes.map((scope) => [scope, `Allows ${scope}`])),
            },
          },
        },
        oauthClientBasic: { type: "http", scheme: "basic" },
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
OAuth enabled: ${config.oauthEnabled}
OAuth mode: ${config.oauthEnabled ? config.oauthMode : "disabled"}
Partner registration enabled: ${config.partnerRegistrationEnabled}
MCP enabled: ${config.mcpEnabled}
Public paid resource enabled: ${config.publicResourceEnabled}
Public paid resource: ${config.publicResourceEnabled ? config.publicResourceUrl : "unavailable"}
Facilitator: ${config.publicResourceEnabled ? config.facilitatorOrigin : config.serviceOrigin}
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

${
  config.publicResourceEnabled
    ? `The public resource at ${config.publicResourceUrl} returns a standard PAYMENT-REQUIRED challenge, accepts PAYMENT-SIGNATURE plus the issued X-NAYORI-SIGNED-QUOTE extension, and returns 202 until Stacks confirmation. It is delivered only with PAYMENT-RESPONSE after the isolated facilitator confirms settlement.`
    : "No public paid resource is enabled on this runtime."
}

SDK: https://github.com/PerkOS-xyz/PerkOS-Nayori-Agent-SDK
Product: https://nayori.ai
`;
}
