import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../src/rate-limit.js";

describe("FixedWindowRateLimiter", () => {
  it("limits within a minute and resets at the next window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter(2, () => now);

    expect(limiter.consume("merchant").allowed).toBe(true);
    expect(limiter.consume("merchant").allowed).toBe(true);
    expect(limiter.consume("merchant")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 60,
    });

    now += 60_000;
    expect(limiter.consume("merchant").allowed).toBe(true);
  });
});
