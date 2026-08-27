import { z } from "zod";

import { MerchantAuthenticationError, type MerchantAuthenticator } from "./auth.js";
import type { AppConfig } from "./config.js";
import { createSupportedDocument } from "./documents.js";
import type { QuoteService } from "./quotes.js";
import type { SettlementService } from "./settlement.js";

const requestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .strict();

const toolCallSchema = z
  .object({
    name: z.enum(["nayori_supported", "nayori_request_quote", "nayori_get_settlement"]),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export class McpAuthenticationError extends Error {
  constructor(readonly code: "unauthorized" | "insufficient_scope") {
    super(code);
    this.name = "McpAuthenticationError";
  }
}

export type McpResponse =
  | { readonly jsonrpc: "2.0"; readonly id: string | number | null; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: string | number | null;
      readonly error: { readonly code: number; readonly message: string };
    };

const tools = [
  {
    name: "nayori_supported",
    description: "Read Nayori's enabled x402 networks, assets and settlement capabilities.",
    inputSchema: { type: "object", additionalProperties: false },
  },
  {
    name: "nayori_request_quote",
    description: "Issue a signed, request-bound Nayori x402 quote for an allowed merchant route.",
    inputSchema: {
      type: "object",
      required: ["routeId", "request"],
      properties: {
        routeId: { type: "string" },
        request: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "nayori_get_settlement",
    description: "Read a merchant-isolated settlement and its confirmation receipt status.",
    inputSchema: {
      type: "object",
      required: ["settlementId"],
      properties: { settlementId: { type: "string" } },
      additionalProperties: false,
    },
  },
] as const;

function success(id: string | number | null, result: unknown): McpResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export type McpService = {
  handle(authorization: string | undefined, input: unknown): Promise<McpResponse>;
};

export function createMcpService(options: {
  readonly config: AppConfig;
  readonly authenticator: MerchantAuthenticator;
  readonly quoteService?: QuoteService;
  readonly settlementService?: SettlementService;
}): McpService {
  const { config, authenticator, quoteService, settlementService } = options;
  return {
    async handle(authorization, input) {
      try {
        await authenticator.authenticate(authorization, "mcp:invoke");
      } catch (error) {
        if (error instanceof MerchantAuthenticationError) {
          throw new McpAuthenticationError(error.code);
        }
        throw error;
      }
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) return failure(null, -32600, "Invalid Request");
      const { id, method, params } = parsed.data;
      if (method === "initialize") {
        return success(id, {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "nayori-x402", version: "0.5.0" },
        });
      }
      if (method === "ping") return success(id, {});
      if (method === "tools/list") return success(id, { tools });
      if (method !== "tools/call") return failure(id, -32601, "Method not found");

      const call = toolCallSchema.safeParse(params);
      if (!call.success) return failure(id, -32602, "Invalid tool arguments");
      try {
        let value: unknown;
        if (call.data.name === "nayori_supported") {
          value = createSupportedDocument(config);
        } else if (call.data.name === "nayori_request_quote") {
          if (!quoteService) throw new Error("Quote issuance is unavailable.");
          value = (await quoteService.issue(authorization, call.data.arguments)).response;
        } else {
          if (!settlementService) throw new Error("Settlement reads are unavailable.");
          const settlementId = call.data.arguments.settlementId;
          if (typeof settlementId !== "string") throw new Error("settlementId is required.");
          value = await settlementService.get(authorization, settlementId);
        }
        return success(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (error) {
        return success(id, {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "The tool call failed.",
            },
          ],
          isError: true,
        });
      }
    },
  };
}
