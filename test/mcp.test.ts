import {
  createNayoriX402PaymentRequirements,
  createNayoriX402Quote,
} from "@perkos/agent-sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  MerchantAuthenticationError,
  type MerchantAuthenticator,
} from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { MerchantRecord } from "../src/merchant.js";
import { createMcpService, McpAuthenticationError } from "../src/mcp.js";
import type { PaidResourceService } from "../src/paid-resource.js";
import type { IssuedQuoteResponse, QuoteService } from "../src/quotes.js";

const merchant: MerchantRecord = {
  merchantId: "mcp-merchant",
  allowedOrigins: ["https://partner.example"],
  allowedAudiences: ["partner:api"],
  recipientAllowlist: ["ST000000000000000000002AMW42H"],
  routeConfig: {
    version: 1,
    routes: {
      api: {
        method: "POST",
        pathPrefix: "/api",
        audience: "partner:api",
        network: "testnet",
        asset: "stx",
        amount: "1",
        payTo: "ST000000000000000000002AMW42H",
        ttlSeconds: 60,
      },
    },
  },
};

const config = loadConfig({
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
  OAUTH_ENABLED: "true",
  MCP_ENABLED: "true",
  OAUTH_SIGNING_PRIVATE_JWK_JSON: '{"configured":"outside-github"}',
});

const publicConfig = loadConfig({
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
  SERVICE_ORIGIN: "https://api.nayori.ai",
  STACKS_NETWORK: "testnet",
  OAUTH_ENABLED: "true",
  MCP_ENABLED: "true",
  OAUTH_SIGNING_PRIVATE_JWK_JSON: '{"configured":"outside-github"}',
  PUBLIC_RESOURCE_ENABLED: "true",
  PUBLIC_RESOURCE_URL: "https://nayori.ai/api/v1",
  PUBLIC_RESOURCE_ROUTE_ID: "nayori-capability-report",
  FACILITATOR_ORIGIN: "https://facilitator.nayori.ai",
  FACILITATOR_MERCHANT_API_KEY: `ny_mk_${"A".repeat(43)}`,
});

let publicIssuedQuote: IssuedQuoteResponse;

beforeAll(async () => {
  const now = Math.floor(Date.now() / 1_000);
  const quote = await createNayoriX402Quote({
    quoteId: `nq_${"b".repeat(32)}`,
    merchantId: "nayori-public-resource",
    network: "testnet",
    asset: "stx",
    amount: 4_000n,
    payTo: "ST000000000000000000002AMW42H",
    method: "GET",
    url: publicConfig.publicResourceUrl,
    issuedAt: now,
    expiresAt: now + 300,
  });
  publicIssuedQuote = {
    quote,
    paymentRequirements: await createNayoriX402PaymentRequirements(quote),
    signedQuote: "signed.public.quote",
    tokenType: "JWT",
    verification: {
      algorithm: "EdDSA",
      keyId: "public-quote-key",
      jwksUrl: "https://facilitator.nayori.ai/.well-known/jwks.json",
    },
  };
});

function service(allowed = true) {
  const authenticator: MerchantAuthenticator = {
    async authenticate(_authorization, requiredScope) {
      if (!allowed) throw new MerchantAuthenticationError("insufficient_scope", requiredScope);
      return merchant;
    },
  };
  const quoteService: QuoteService = {
    publicJwks: { keys: [] },
    async issue(_authorization, input) {
      return {
        merchantId: merchant.merchantId,
        routeId: "api",
        quoteId: "nq_test",
        response: input as never,
      };
    },
  };
  return createMcpService({ config, authenticator, quoteService });
}

describe("authenticated MCP endpoint", () => {
  it("negotiates the protocol and lists only implemented tools", async () => {
    const mcp = service();
    const initialized = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const listed = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(initialized).toMatchObject({
      result: { serverInfo: { name: "nayori-x402", version: "0.7.3" } },
    });
    expect(listed).toMatchObject({
      result: {
        tools: [
          { name: "nayori_supported" },
          { name: "nayori_request_quote" },
          { name: "nayori_get_settlement" },
        ],
      },
    });
  });

  it("invokes the discovery and quote tools with structured output", async () => {
    const mcp = service();
    const supported = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: "supported",
      method: "tools/call",
      params: { name: "nayori_supported", arguments: {} },
    });
    const quote = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: "quote",
      method: "tools/call",
      params: {
        name: "nayori_request_quote",
        arguments: { routeId: "api", request: { method: "POST", url: "https://partner.example/api" } },
      },
    });

    expect(supported).toMatchObject({ result: { isError: false, structuredContent: { service: "nayori-x402-facilitator" } } });
    expect(quote).toMatchObject({ result: { isError: false, structuredContent: { routeId: "api" } } });
  });

  it("rejects a token without mcp:invoke before parsing JSON-RPC", async () => {
    await expect(service(false).handle("Bearer token", {})).rejects.toBeInstanceOf(McpAuthenticationError);
  });

  it("delegates the exact public resource quote to the isolated facilitator service", async () => {
    const scopes: string[] = [];
    const authenticator: MerchantAuthenticator = {
      async authenticate(_authorization, requiredScope) {
        scopes.push(requiredScope);
        return merchant;
      },
    };
    const issueQuote = vi.fn(async () => publicIssuedQuote);
    const publicQuoteService: Pick<PaidResourceService, "issueQuote"> = { issueQuote };
    const mcp = createMcpService({
      config: publicConfig,
      authenticator,
      publicQuoteService,
    });

    const response = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: "public-quote",
      method: "tools/call",
      params: {
        name: "nayori_request_quote",
        arguments: {
          routeId: "nayori-capability-report",
          request: { method: "GET", url: "https://nayori.ai/api/v1" },
        },
      },
    }, "mcp-http-request-id");

    expect(response).toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          quote: { merchantId: "nayori-public-resource", url: "https://nayori.ai/api/v1" },
          signedQuote: "signed.public.quote",
          verification: { jwksUrl: "https://facilitator.nayori.ai/.well-known/jwks.json" },
        },
      },
    });
    expect(scopes).toEqual(["mcp:invoke", "quotes:create"]);
    expect(issueQuote).toHaveBeenCalledOnce();
    expect(issueQuote).toHaveBeenCalledWith("mcp-http-request-id");
  });

  it("rejects a public route mismatch without contacting the facilitator", async () => {
    const authenticator: MerchantAuthenticator = {
      async authenticate() {
        return merchant;
      },
    };
    const issueQuote = vi.fn(async () => publicIssuedQuote);
    const mcp = createMcpService({
      config: publicConfig,
      authenticator,
      publicQuoteService: { issueQuote },
    });

    const response = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: "mismatch",
      method: "tools/call",
      params: {
        name: "nayori_request_quote",
        arguments: {
          routeId: "nayori-capability-report",
          request: { method: "POST", url: "https://nayori.ai/api/v1" },
        },
      },
    });

    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "The protected request does not match the public resource route." }],
      },
    });
    expect(issueQuote).not.toHaveBeenCalled();
  });

  it("requires quotes:create in addition to mcp:invoke for the public route", async () => {
    const authenticator: MerchantAuthenticator = {
      async authenticate(_authorization, requiredScope) {
        if (requiredScope === "quotes:create") {
          throw new MerchantAuthenticationError("insufficient_scope", requiredScope);
        }
        return merchant;
      },
    };
    const issueQuote = vi.fn(async () => publicIssuedQuote);
    const mcp = createMcpService({
      config: publicConfig,
      authenticator,
      publicQuoteService: { issueQuote },
    });

    const response = await mcp.handle("Bearer token", {
      jsonrpc: "2.0",
      id: "scope",
      method: "tools/call",
      params: {
        name: "nayori_request_quote",
        arguments: {
          routeId: "nayori-capability-report",
          request: { method: "GET", url: "https://nayori.ai/api/v1" },
        },
      },
    });

    expect(response).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "A bearer token with quotes:create is required." }],
      },
    });
    expect(issueQuote).not.toHaveBeenCalled();
  });
});
