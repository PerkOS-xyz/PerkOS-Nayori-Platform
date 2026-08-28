import type { IssuedQuoteResponse } from "./quotes.js";
import type {
  PublicDelivery,
  PublicSettlement,
  SettlementResult,
} from "./settlement.js";

type FacilitatorErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503;

export class FacilitatorClientError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly status: FacilitatorErrorStatus,
    readonly retryAfterSeconds?: number,
  ) {
    super(publicMessage);
    this.name = "FacilitatorClientError";
  }
}

export type FacilitatorClient = {
  issueQuote(input: unknown, requestId: string): Promise<IssuedQuoteResponse>;
  settle(input: unknown, requestId: string): Promise<SettlementResult>;
  getSettlement(settlementId: string, requestId: string): Promise<PublicSettlement>;
  claimDelivery(settlementId: string, requestId: string): Promise<PublicDelivery>;
  completeDelivery(
    settlementId: string,
    responseDigest: string,
    requestId: string,
  ): Promise<PublicDelivery>;
};

type FetchLike = typeof globalThis.fetch;

function safeError(body: unknown): { code: string; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { code: "facilitator_error", message: "The facilitator rejected the request." };
  }
  const error = "error" in body ? body.error : null;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return { code: "facilitator_error", message: "The facilitator rejected the request." };
  }
  const code = "code" in error && typeof error.code === "string"
    ? error.code
    : "facilitator_error";
  const message = "message" in error && typeof error.message === "string"
    ? error.message
    : "The facilitator rejected the request.";
  return { code, message };
}

function errorStatus(status: number): FacilitatorErrorStatus {
  if ([400, 401, 403, 404, 409, 422, 429].includes(status)) {
    return status as FacilitatorErrorStatus;
  }
  return status >= 500 ? 503 : 502;
}

export function createFacilitatorClient(options: {
  readonly origin: string;
  readonly merchantApiKey: string;
  readonly timeoutMs: number;
  readonly fetch?: FetchLike;
}): FacilitatorClient {
  const origin = options.origin.replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly requestId: string;
    readonly body?: unknown;
  }): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${origin}${input.path}`, {
        method: input.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${options.merchantApiKey}`,
          "content-type": "application/json",
          "x-request-id": input.requestId,
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new FacilitatorClientError(
        "facilitator_unavailable",
        "The Nayori facilitator is temporarily unavailable.",
        503,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FacilitatorClientError(
        "invalid_facilitator_response",
        "The Nayori facilitator returned an invalid response.",
        502,
      );
    }
    if (!response.ok) {
      const error = safeError(body);
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new FacilitatorClientError(
        error.code,
        error.message,
        errorStatus(response.status),
        Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return body as T;
  }

  return {
    issueQuote(input, requestId) {
      return request<IssuedQuoteResponse>({
        method: "POST",
        path: "/v1/quotes",
        body: input,
        requestId,
      });
    },
    settle(input, requestId) {
      return request<SettlementResult>({
        method: "POST",
        path: "/v1/x402/settle",
        body: input,
        requestId,
      });
    },
    async getSettlement(settlementId, requestId) {
      const result = await request<{ settlement: PublicSettlement }>({
        method: "GET",
        path: `/v1/x402/settlements/${encodeURIComponent(settlementId)}`,
        requestId,
      });
      return result.settlement;
    },
    async claimDelivery(settlementId, requestId) {
      const result = await request<{ delivery: PublicDelivery }>({
        method: "POST",
        path: `/v1/x402/settlements/${encodeURIComponent(settlementId)}/delivery/claim`,
        requestId,
      });
      return result.delivery;
    },
    async completeDelivery(settlementId, responseDigest, requestId) {
      const result = await request<{ delivery: PublicDelivery }>({
        method: "POST",
        path: `/v1/x402/settlements/${encodeURIComponent(settlementId)}/delivery/complete`,
        body: { responseDigest },
        requestId,
      });
      return result.delivery;
    },
  };
}
