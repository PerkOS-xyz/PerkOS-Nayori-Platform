import { describe, expect, it } from "vitest";

import {
  MerchantAuthenticationError,
  type MerchantAuthenticator,
} from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { MerchantRecord } from "../src/merchant.js";
import { createMcpService, McpAuthenticationError } from "../src/mcp.js";
import type { QuoteService } from "../src/quotes.js";

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

    expect(initialized).toMatchObject({ result: { serverInfo: { name: "nayori-x402" } } });
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
});
