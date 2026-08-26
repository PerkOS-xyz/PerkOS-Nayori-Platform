import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const REQUIRED_ENVIRONMENT: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
  NODE_ENV: "test",
};

describe("loadConfig", () => {
  it("uses fail-closed foundation defaults", () => {
    const config = loadConfig(REQUIRED_ENVIRONMENT);

    expect(config.stacksNetwork).toBe("testnet");
    expect(config.settlementEnabled).toBe(false);
    expect(config.sponsorshipEnabled).toBe(false);
    expect(config.port).toBe(8080);
  });

  it("normalizes the service origin", () => {
    const config = loadConfig({
      ...REQUIRED_ENVIRONMENT,
      SERVICE_ORIGIN: "https://api.nayori.ai/",
    });

    expect(config.serviceOrigin).toBe("https://api.nayori.ai");
  });

  it.each(["SETTLEMENT_ENABLED", "SPONSORSHIP_ENABLED"])(
    "rejects a truthy %s flag",
    (flag) => {
      expect(() => loadConfig({ ...REQUIRED_ENVIRONMENT, [flag]: "true" })).toThrow();
    },
  );

  it("rejects a non-PostgreSQL database URL", () => {
    expect(() =>
      loadConfig({ ...REQUIRED_ENVIRONMENT, DATABASE_URL: "https://database.example" }),
    ).toThrow(/postgres/i);
  });
});
