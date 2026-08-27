import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { DatabaseHealth } from "../src/database.js";
import type { AppLogger, LogFields } from "../src/logger.js";

const config = loadConfig({
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
  RELEASE_SHA: "abc1234",
  SERVICE_ORIGIN: "https://api.nayori.ai",
});

class FakeDatabase implements DatabaseHealth {
  pingCount = 0;

  constructor(private readonly failure?: Error) {}

  async ping(): Promise<void> {
    this.pingCount += 1;
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {}
}

class MemoryLogger implements AppLogger {
  readonly infoEvents: LogFields[] = [];
  readonly errorEvents: LogFields[] = [];

  info(fields: LogFields): void {
    this.infoEvents.push(fields);
  }

  error(fields: LogFields): void {
    this.errorEvents.push(fields);
  }
}

function makeApp(database: DatabaseHealth = new FakeDatabase()) {
  const logger = new MemoryLogger();
  return { app: createApp({ config, database, logger }), logger };
}

describe("Nayori foundation API", () => {
  it("refuses to start quote issuance without a wired quote service", () => {
    const quoteConfig = loadConfig({
      DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
      NODE_ENV: "test",
      QUOTE_ISSUANCE_ENABLED: "true",
      QUOTE_SIGNING_PRIVATE_JWK_JSON: '{"configured":"outside-github"}',
    });

    expect(() =>
      createApp({
        config: quoteConfig,
        database: new FakeDatabase(),
        logger: new MemoryLogger(),
      }),
    ).toThrow(/quote service/i);
  });

  it("returns liveness without touching PostgreSQL", async () => {
    const database = new FakeDatabase();
    const { app } = makeApp(database);
    const response = await app.request("/health", {
      headers: { "x-request-id": "test-request-1" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("test-request-1");
    expect(response.headers.get("x-service-release")).toBe("abc1234");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "nayori-x402-facilitator",
      version: "0.5.0",
      release: "abc1234",
    });
    expect(database.pingCount).toBe(0);
  });

  it("replaces an unsafe request ID", async () => {
    const { app } = makeApp();
    const response = await app.request("/health", {
      headers: { "x-request-id": "invalid request id with spaces" },
    });

    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("reports readiness only after a database ping", async () => {
    const database = new FakeDatabase();
    const { app } = makeApp(database);
    const response = await app.request("/ready");

    expect(response.status).toBe(200);
    expect(database.pingCount).toBe(1);
    expect(await response.json()).toMatchObject({ status: "ready", database: "available" });
  });

  it("fails readiness without leaking the database error", async () => {
    const database = new FakeDatabase(new Error("postgresql://secret@database"));
    const { app } = makeApp(database);
    const response = await app.request("/ready");
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("not_ready");
    expect(body).not.toContain("secret");
  });

  it("does not advertise unavailable payment operations", async () => {
    const { app } = makeApp();
    const supported = (await (await app.request("/supported")).json()) as {
      status: string;
      settlementEnabled: boolean;
      sponsorshipEnabled: boolean;
      quoteIssuanceEnabled: boolean;
      networks: unknown[];
      mechanisms: unknown[];
    };
    const openapi = (await (await app.request("/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    const manifest = (await (await app.request("/.well-known/agent.json")).json()) as {
      availability: Record<string, boolean>;
    };

    expect(supported).toMatchObject({
      status: "foundation",
      quoteIssuanceEnabled: false,
      settlementEnabled: false,
      sponsorshipEnabled: false,
      networks: [],
      mechanisms: [],
    });
    expect(openapi.paths).not.toHaveProperty("/v1/x402/settle");
    expect(openapi.paths).not.toHaveProperty("/v1/quotes");
    expect(manifest.availability).toMatchObject({ quote: false, verify: false, settle: false });
  });

  it("returns agent-readable guidance that is explicit about disabled settlement", async () => {
    const { app } = makeApp();
    const response = await app.request("/llms.txt");
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("Settlement enabled: false");
    expect(body).toContain("does not issue quotes");
  });

  it("applies security headers", async () => {
    const { app } = makeApp();
    const response = await app.request("/health");

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
  });

  it("returns a typed 404 instead of a settlement placeholder", async () => {
    const { app } = makeApp();
    const response = await app.request("/v1/x402/settle", { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects oversized v1 requests before routing", async () => {
    const { app } = makeApp();
    const response = await app.request("/v1/x402/settle", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 + 1) },
      body: "x",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
  });
});
