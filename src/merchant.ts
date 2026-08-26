import { createHash, randomBytes } from "node:crypto";

import { canonicalizeNayoriX402ResourceUrl } from "@perkos/agent-sdk";
import { z } from "zod";

const merchantIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const routeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);
const canonicalAmountSchema = z.string().regex(/^[1-9][0-9]*$/).max(78);
const routePathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.startsWith("/") && !value.includes("?") && !value.includes("#"), {
    message: "pathPrefix must be an absolute path without query or fragment.",
  });

export const merchantRouteSchema = z
  .object({
    method: z.string().regex(/^[A-Z]+$/).max(16),
    pathPrefix: routePathSchema,
    audience: z.string().min(1).max(2048),
    network: z.enum(["testnet", "mainnet"]),
    asset: z.enum(["stx", "sbtc", "usdcx"]),
    amount: canonicalAmountSchema,
    payTo: z.string().min(1).max(256),
    ttlSeconds: z.number().int().min(15).max(300),
  })
  .strict();

export const merchantRouteConfigSchema = z
  .object({
    version: z.literal(1),
    routes: z.record(routeIdSchema, merchantRouteSchema),
  })
  .strict()
  .refine((value) => Object.keys(value.routes).length > 0, {
    message: "At least one merchant route is required.",
  });

const allowedOriginsSchema = z
  .array(z.url())
  .min(1)
  .max(64)
  .superRefine((origins, context) => {
    origins.forEach((origin, index) => {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Allowed origins must be canonical HTTPS origins.",
        });
      }
    });
  });

export const merchantProvisioningSchema = z
  .object({
    merchantId: merchantIdSchema,
    status: z.enum(["active", "disabled"]).default("active"),
    allowedOrigins: allowedOriginsSchema,
    allowedAudiences: z.array(z.string().min(1).max(2048)).min(1).max(64),
    recipientAllowlist: z.array(z.string().min(1).max(256)).min(1).max(64),
    routeConfig: merchantRouteConfigSchema,
  })
  .strict();

export const quoteRequestSchema = z
  .object({
    routeId: routeIdSchema,
    request: z
      .object({
        method: z.string().regex(/^[A-Z]+$/).max(16),
        url: z.url().max(4096),
        body: z.string().max(49_152).optional(),
      })
      .strict(),
  })
  .strict();

export type MerchantRoute = z.infer<typeof merchantRouteSchema>;
export type MerchantRouteConfig = z.infer<typeof merchantRouteConfigSchema>;
export type MerchantProvisioning = z.infer<typeof merchantProvisioningSchema>;
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export type MerchantRecord = {
  readonly merchantId: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedAudiences: readonly string[];
  readonly recipientAllowlist: readonly string[];
  readonly routeConfig: MerchantRouteConfig;
};

const merchantRecordSchema = z
  .object({
    merchantId: merchantIdSchema,
    allowedOrigins: allowedOriginsSchema,
    allowedAudiences: z.array(z.string().min(1).max(2048)).min(1).max(64),
    recipientAllowlist: z.array(z.string().min(1).max(256)).min(1).max(64),
    routeConfig: merchantRouteConfigSchema,
  })
  .strict();

export function parseMerchantRecord(value: unknown): MerchantRecord {
  return merchantRecordSchema.parse(value);
}

const API_KEY_PATTERN = /^ny_mk_[A-Za-z0-9_-]{43}$/;

export function generateMerchantApiKey(): string {
  return `ny_mk_${randomBytes(32).toString("base64url")}`;
}

export function hashMerchantApiKey(apiKey: string): string {
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("Merchant API key has an invalid format.");
  }
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function parseBearerApiKey(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("Merchant bearer credential is missing.");
  }
  const apiKey = authorization.slice("Bearer ".length);
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error("Merchant bearer credential is invalid.");
  }
  return apiKey;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

export function hashMerchantRouteConfig(config: MerchantRouteConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(config)), "utf8")
    .digest("hex");
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  if (pathname === prefix) return true;
  return pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

export type ResolvedQuotePolicy = {
  readonly route: MerchantRoute;
  readonly canonicalUrl: string;
};

export function resolveQuotePolicy(
  merchant: MerchantRecord,
  request: QuoteRequest,
  configuredNetwork: "testnet" | "mainnet",
  maximumTtlSeconds: number,
): ResolvedQuotePolicy {
  const route = merchant.routeConfig.routes[request.routeId];
  if (!route) throw new Error("unknown_route");
  if (route.method !== request.request.method) throw new Error("route_policy_mismatch");
  if (route.network !== configuredNetwork) throw new Error("route_policy_mismatch");
  if (route.ttlSeconds > maximumTtlSeconds) throw new Error("route_policy_mismatch");
  if (!merchant.allowedAudiences.includes(route.audience)) {
    throw new Error("route_policy_mismatch");
  }
  if (!merchant.recipientAllowlist.includes(route.payTo)) {
    throw new Error("route_policy_mismatch");
  }

  const canonicalUrl = canonicalizeNayoriX402ResourceUrl(request.request.url);
  const url = new URL(canonicalUrl);
  if (url.protocol !== "https:") throw new Error("route_policy_mismatch");
  if (!merchant.allowedOrigins.includes(url.origin)) throw new Error("route_policy_mismatch");
  if (!pathMatchesPrefix(url.pathname, route.pathPrefix)) {
    throw new Error("route_policy_mismatch");
  }

  return { route, canonicalUrl };
}
