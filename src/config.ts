import { z } from "zod";

const postgresUrlSchema = z.string().min(1).superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      context.addIssue({
        code: "custom",
        message: "DATABASE_URL must use postgres:// or postgresql://.",
      });
    }
  } catch {
    context.addIssue({ code: "custom", message: "DATABASE_URL must be a valid URL." });
  }
});

const disabledFeatureFlag = z
  .union([z.literal("false"), z.literal("0")])
  .default("false")
  .transform(() => false as const);

const booleanFlag = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    SERVICE_ORIGIN: z.url().default("https://api.nayori.ai"),
    RELEASE_SHA: z.string().min(1).max(128).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    DATABASE_URL: postgresUrlSchema,
    DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(5_000),
    DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().min(250).max(60_000).default(10_000),
    STACKS_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    QUOTE_ISSUANCE_ENABLED: booleanFlag,
    QUOTE_SIGNING_PRIVATE_JWK_JSON: z.string().min(1).optional(),
    QUOTE_PREVIOUS_PUBLIC_JWKS_JSON: z.string().min(1).default('{"keys":[]}'),
    QUOTE_MAX_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(300),
    QUOTE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
    SETTLEMENT_ENABLED: disabledFeatureFlag,
    SPONSORSHIP_ENABLED: disabledFeatureFlag,
  })
  .superRefine((value, context) => {
    if (value.QUOTE_ISSUANCE_ENABLED && !value.QUOTE_SIGNING_PRIVATE_JWK_JSON) {
      context.addIssue({
        code: "custom",
        path: ["QUOTE_SIGNING_PRIVATE_JWK_JSON"],
        message: "QUOTE_SIGNING_PRIVATE_JWK_JSON is required when quote issuance is enabled.",
      });
    }
  });

export type AppConfig = {
  readonly nodeEnvironment: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly serviceOrigin: string;
  readonly releaseSha: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly databaseUrl: string;
  readonly databaseSsl: "disable" | "require";
  readonly databasePoolMax: number;
  readonly databaseConnectTimeoutMs: number;
  readonly databaseQueryTimeoutMs: number;
  readonly stacksNetwork: "testnet" | "mainnet";
  readonly quoteIssuanceEnabled: boolean;
  readonly quoteSigningPrivateJwkJson?: string;
  readonly quotePreviousPublicJwksJson: string;
  readonly quoteMaxTtlSeconds: number;
  readonly quoteRateLimitPerMinute: number;
  readonly settlementEnabled: false;
  readonly sponsorshipEnabled: false;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = environmentSchema.parse(environment);

  return {
    nodeEnvironment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    serviceOrigin: value.SERVICE_ORIGIN.replace(/\/$/, ""),
    releaseSha: value.RELEASE_SHA,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    databaseSsl: value.DATABASE_SSL,
    databasePoolMax: value.DATABASE_POOL_MAX,
    databaseConnectTimeoutMs: value.DATABASE_CONNECT_TIMEOUT_MS,
    databaseQueryTimeoutMs: value.DATABASE_QUERY_TIMEOUT_MS,
    stacksNetwork: value.STACKS_NETWORK,
    quoteIssuanceEnabled: value.QUOTE_ISSUANCE_ENABLED,
    quoteSigningPrivateJwkJson: value.QUOTE_SIGNING_PRIVATE_JWK_JSON,
    quotePreviousPublicJwksJson: value.QUOTE_PREVIOUS_PUBLIC_JWKS_JSON,
    quoteMaxTtlSeconds: value.QUOTE_MAX_TTL_SECONDS,
    quoteRateLimitPerMinute: value.QUOTE_RATE_LIMIT_PER_MINUTE,
    settlementEnabled: value.SETTLEMENT_ENABLED,
    sponsorshipEnabled: value.SPONSORSHIP_ENABLED,
  };
}
