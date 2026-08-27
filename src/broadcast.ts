import type { AppConfig } from "./config.js";

const TXID_PATTERN = /^0x[0-9a-f]{64}$/;

export type BroadcastResult =
  | { readonly outcome: "accepted"; readonly txid: string }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "ambiguous"; readonly reason: string };

export type TransactionBroadcaster = {
  broadcast(rawTransactionHex: string): Promise<BroadcastResult>;
};

type BroadcastFetch = typeof globalThis.fetch;

function normalizedTxid(value: unknown): string | null {
  const candidate =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && "txid" in value
        ? (value as { txid?: unknown }).txid
        : null;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.toLowerCase().startsWith("0x")
    ? candidate.toLowerCase()
    : `0x${candidate.toLowerCase()}`;
  return TXID_PATTERN.test(normalized) ? normalized : null;
}

function rejectionReason(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const candidate =
      "reason" in body
        ? (body as { reason?: unknown }).reason
        : "error" in body
          ? (body as { error?: unknown }).error
          : undefined;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate.slice(0, 128);
    }
  }
  return "broadcast_rejected";
}

async function responseBody(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 16_384);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createHiroTransactionBroadcaster(options: {
  readonly config: AppConfig;
  readonly fetch?: BroadcastFetch;
}): TransactionBroadcaster {
  const request = options.fetch ?? globalThis.fetch;

  return {
    async broadcast(rawTransactionHex) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.config.stacksBroadcastTimeoutMs);
      try {
        const response = await request(`${options.config.stacksApiUrl}/v2/transactions`, {
          method: "POST",
          body: Buffer.from(rawTransactionHex, "hex"),
          headers: { "content-type": "application/octet-stream" },
          redirect: "error",
          signal: controller.signal,
        });
        const body = await responseBody(response);
        if (response.ok) {
          const txid = normalizedTxid(body);
          return txid
            ? { outcome: "accepted", txid }
            : { outcome: "ambiguous", reason: "broadcast_response_missing_txid" };
        }
        if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
          return { outcome: "rejected", reason: rejectionReason(body) };
        }
        return { outcome: "ambiguous", reason: `broadcast_http_${response.status}` };
      } catch (error) {
        return {
          outcome: "ambiguous",
          reason:
            error instanceof Error && error.name === "AbortError"
              ? "broadcast_timeout"
              : "broadcast_network_error",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
