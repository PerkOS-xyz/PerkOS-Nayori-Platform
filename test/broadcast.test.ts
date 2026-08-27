import { describe, expect, it, vi } from "vitest";

import { createHiroTransactionBroadcaster } from "../src/broadcast.js";
import { loadConfig } from "../src/config.js";

const TXID = `0x${"a".repeat(64)}`;

function config(timeout = 500) {
  return loadConfig({
    DATABASE_URL: "postgresql://nayori:test@localhost:5432/nayori_test",
    NODE_ENV: "test",
    STACKS_BROADCAST_TIMEOUT_MS: String(timeout),
  });
}

describe("Hiro transaction broadcaster", () => {
  it("submits canonical bytes once and accepts a normalized txid", async () => {
    const request = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        void url;
        void init;
        return new Response(JSON.stringify(TXID), { status: 200 });
      },
    );
    const broadcaster = createHiroTransactionBroadcaster({
      config: config(),
      fetch: request as typeof fetch,
    });

    await expect(broadcaster.broadcast("00ff")).resolves.toEqual({
      outcome: "accepted",
      txid: TXID,
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [, init] = request.mock.calls[0]!;
    expect(Buffer.from(init?.body as Uint8Array).toString("hex")).toBe("00ff");
    expect(init?.redirect).toBe("error");
  });

  it("separates definitive rejection from ambiguous upstream responses", async () => {
    const rejected = createHiroTransactionBroadcaster({
      config: config(),
      fetch: (async () =>
        new Response(JSON.stringify({ reason: "BadNonce" }), { status: 400 })) as typeof fetch,
    });
    const overloaded = createHiroTransactionBroadcaster({
      config: config(),
      fetch: (async () => new Response("busy", { status: 429 })) as typeof fetch,
    });

    await expect(rejected.broadcast("00")).resolves.toEqual({
      outcome: "rejected",
      reason: "BadNonce",
    });
    await expect(overloaded.broadcast("00")).resolves.toEqual({
      outcome: "ambiguous",
      reason: "broadcast_http_429",
    });
  });

  it("treats a timeout as ambiguous and never retries", async () => {
    const request = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const broadcaster = createHiroTransactionBroadcaster({
      config: config(500),
      fetch: request as typeof fetch,
    });

    await expect(broadcaster.broadcast("00")).resolves.toEqual({
      outcome: "ambiguous",
      reason: "broadcast_timeout",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
