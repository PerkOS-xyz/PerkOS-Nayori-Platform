import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabaseHealth } from "../src/database.js";
import type { AppLogger } from "../src/logger.js";
import type { McpService } from "../src/mcp.js";
import type { MerchantRecord } from "../src/merchant.js";
import type { OAuthService } from "../src/oauth.js";

class FakeDatabase implements DatabaseHealth {
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

const logger: AppLogger = { info() {}, error() {} };
const merchant: MerchantRecord = {
  merchantId: "partner",
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

const oauthService: OAuthService = {
  publicJwks: { keys: [] },
  async issueChallenge() {
    return {
      challengeId: `nc_${"a".repeat(32)}`,
      message: "sign me",
      expiresAt: new Date(2_000_000_000_000).toISOString(),
      walletAddress: "ST000000000000000000002AMW42H",
      network: "testnet",
    };
  },
  async register() {
    return {
      clientId: `ny_oc_${"A".repeat(24)}`,
      clientSecret: `ny_cs_${"A".repeat(43)}`,
      tokenEndpoint: "https://api.nayori.ai/oauth/token",
      scopes: ["mcp:invoke"],
      walletAddress: "ST000000000000000000002AMW42H",
    };
  },
  async issueToken() {
    return { access_token: "signed", token_type: "Bearer", expires_in: 300, scope: "mcp:invoke" };
  },
  async authenticate() {
    return merchant;
  },
};

const mcpService: McpService = {
  async handle() {
    return { jsonrpc: "2.0", id: 1, result: { ok: true } };
  },
};

describe("OAuth and MCP discovery routes", () => {
  it("publishes RFC metadata, auth.md, the server card and the MCP endpoint", async () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
      NODE_ENV: "test",
      SERVICE_ORIGIN: "https://api.nayori.ai",
      OAUTH_ENABLED: "true",
      PARTNER_REGISTRATION_ENABLED: "true",
      MCP_ENABLED: "true",
      OAUTH_SIGNING_PRIVATE_JWK_JSON: '{"configured":"outside-github"}',
    });
    const app = createApp({
      config,
      database: new FakeDatabase(),
      logger,
      oauthService,
      mcpService,
    });

    const authorization = await app.request("/.well-known/oauth-authorization-server");
    const resource = await app.request("/.well-known/oauth-protected-resource");
    const authGuide = await app.request("/auth.md");
    const card = await app.request("/.well-known/mcp/server-card.json");
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer signed", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

    expect(await authorization.json()).toMatchObject({
      issuer: "https://api.nayori.ai",
      grant_types_supported: ["client_credentials"],
    });
    expect(await resource.json()).toMatchObject({
      resource: "https://api.nayori.ai",
      authorization_servers: ["https://api.nayori.ai"],
    });
    expect(authGuide.headers.get("content-type")).toContain("text/markdown");
    expect(await card.json()).toMatchObject({
      serverInfo: { name: "nayori-x402", version: "0.6.0" },
      server: { url: "https://api.nayori.ai/mcp" },
    });
    expect(await mcp.json()).toMatchObject({ result: { ok: true } });
  });

  it("publishes the apex resource and redirects issuer-owned routes in external mode", async () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
      NODE_ENV: "test",
      SERVICE_ORIGIN: "https://api.nayori.ai",
      OAUTH_ENABLED: "true",
      OAUTH_MODE: "external",
      MCP_ENABLED: "true",
    });
    const app = createApp({
      config,
      database: new FakeDatabase(),
      logger,
      mcpService,
    });

    const authorization = await app.request("/.well-known/oauth-authorization-server");
    const resource = await app.request("/.well-known/oauth-protected-resource");
    const authGuide = await app.request("/auth.md");
    const jwks = await app.request("/oauth/jwks.json");
    const token = await app.request("/oauth/token", { method: "POST" });
    const card = await app.request("/.well-known/mcp/server-card.json");

    expect(authorization.status).toBe(308);
    expect(authorization.headers.get("location")).toBe(
      "https://oauth.nayori.ai/.well-known/oauth-authorization-server",
    );
    expect(await resource.json()).toMatchObject({
      resource: "https://nayori.ai",
      authorization_servers: ["https://oauth.nayori.ai"],
      jwks_uri: "https://oauth.nayori.ai/oauth/jwks.json",
    });
    expect(await authGuide.text()).toMatch(/^# Auth\.md — Nayori agent authentication/);
    expect(jwks.status).toBe(308);
    expect(jwks.headers.get("location")).toBe("https://oauth.nayori.ai/oauth/jwks.json");
    expect(token.status).toBe(404);
    expect(await card.json()).toMatchObject({
      serverInfo: { name: "nayori-x402" },
      authentication: {
        protectedResourceMetadata: "https://nayori.ai/.well-known/oauth-protected-resource",
      },
    });
  });
});
