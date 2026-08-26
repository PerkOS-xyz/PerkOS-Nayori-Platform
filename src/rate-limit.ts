export type RateLimitResult = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
};

type WindowState = {
  count: number;
  startedAtMs: number;
};

export class FixedWindowRateLimiter {
  readonly #windows = new Map<string, WindowState>();

  constructor(
    private readonly maximumPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): RateLimitResult {
    const nowMs = this.now();
    const current = this.#windows.get(key);
    if (!current || nowMs - current.startedAtMs >= 60_000) {
      this.#windows.set(key, { count: 1, startedAtMs: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= this.maximumPerMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (nowMs - current.startedAtMs)) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
