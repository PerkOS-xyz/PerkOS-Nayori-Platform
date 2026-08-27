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

const httpUrlSchema = z.url().superRefine((value, context) => {
  const protocol = new URL(value).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    context.addIssue({ code: "custom", message: "URL must use http:// or https://." });
  }
});

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
    STACKS_API_URL: httpUrlSchema.default("https://api.testnet.hiro.so"),
    STACKS_BROADCAST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
    STACKS_OBSERVATION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),
    QUOTE_ISSUANCE_ENABLED: booleanFlag,
    QUOTE_SIGNING_PRIVATE_JWK_JSON: z.string().min(1).optional(),
    QUOTE_PREVIOUS_PUBLIC_JWKS_JSON: z.string().min(1).default('{"keys":[]}'),
    QUOTE_MAX_TTL_SECONDS: z.coerce.number().int().min(15).max(300).default(300),
    QUOTE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
    PAYMENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(60),
    PAYMENT_VERIFICATION_ENABLED: booleanFlag,
    SETTLEMENT_ENABLED: booleanFlag,
    RECONCILIATION_ENABLED: booleanFlag,
    SETTLEMENT_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(100).default(1),
    RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
    RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(5_000),
    RECONCILIATION_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
    DELIVERY_LEDGER_ENABLED: booleanFlag,
    DELIVERY_RETRY_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),
    OAUTH_ENABLED: booleanFlag,
    PARTNER_REGISTRATION_ENABLED: booleanFlag,
    MCP_ENABLED: booleanFlag,
    OAUTH_SIGNING_PRIVATE_JWK_JSON: z.string().min(1).optional(),
    OAUTH_PREVIOUS_PUBLIC_JWKS_JSON: z.string().min(1).default('{"keys":[]}'),
    OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
    PARTNER_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
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
    if (value.PAYMENT_VERIFICATION_ENABLED && !value.QUOTE_ISSUANCE_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PAYMENT_VERIFICATION_ENABLED"],
        message: "Payment verification requires quote issuance.",
      });
    }
    if (value.SETTLEMENT_ENABLED && !value.PAYMENT_VERIFICATION_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["SETTLEMENT_ENABLED"],
        message: "Settlement requires payment verification.",
      });
    }
    if (value.SETTLEMENT_ENABLED && value.STACKS_NETWORK !== "testnet") {
      context.addIssue({
        code: "custom",
        path: ["STACKS_NETWORK"],
        message: "Settlement is restricted to Stacks testnet in this release.",
      });
    }
    if (value.RECONCILIATION_ENABLED && !value.SETTLEMENT_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["RECONCILIATION_ENABLED"],
        message: "Reconciliation requires testnet settlement.",
      });
    }
    if (value.DELIVERY_LEDGER_ENABLED && !value.RECONCILIATION_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["DELIVERY_LEDGER_ENABLED"],
        message: "The delivery ledger requires reconciliation.",
      });
    }
    if (value.OAUTH_ENABLED && !value.OAUTH_SIGNING_PRIVATE_JWK_JSON) {
      context.addIssue({
        code: "custom",
        path: ["OAUTH_SIGNING_PRIVATE_JWK_JSON"],
        message: "OAUTH_SIGNING_PRIVATE_JWK_JSON is required when OAuth is enabled.",
      });
    }
    if (value.PARTNER_REGISTRATION_ENABLED && !value.OAUTH_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PARTNER_REGISTRATION_ENABLED"],
        message: "Partner registration requires OAuth.",
      });
    }
    if (value.MCP_ENABLED && !value.OAUTH_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["MCP_ENABLED"],
        message: "The MCP endpoint requires OAuth.",
      });
    }
    if (
      value.SETTLEMENT_ENABLED &&
      value.NODE_ENV === "production" &&
      new URL(value.STACKS_API_URL).protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["STACKS_API_URL"],
        message: "Production settlement requires an HTTPS Stacks API URL.",
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
  readonly stacksApiUrl: string;
  readonly stacksBroadcastTimeoutMs: number;
  readonly stacksObservationTimeoutMs: number;
  readonly quoteIssuanceEnabled: boolean;
  readonly quoteSigningPrivateJwkJson?: string;
  readonly quotePreviousPublicJwksJson: string;
  readonly quoteMaxTtlSeconds: number;
  readonly quoteRateLimitPerMinute: number;
  readonly paymentRateLimitPerMinute: number;
  readonly paymentVerificationEnabled: boolean;
  readonly settlementEnabled: boolean;
  readonly reconciliationEnabled: boolean;
  readonly settlementMinConfirmations: number;
  readonly reconciliationBatchSize: number;
  readonly reconciliationIntervalMs: number;
  readonly reconciliationLeaseMs: number;
  readonly deliveryLedgerEnabled: boolean;
  readonly deliveryRetryTtlSeconds: number;
  readonly oauthEnabled: boolean;
  readonly partnerRegistrationEnabled: boolean;
  readonly mcpEnabled: boolean;
  readonly oauthSigningPrivateJwkJson?: string;
  readonly oauthPreviousPublicJwksJson: string;
  readonly oauthAccessTokenTtlSeconds: number;
  readonly partnerChallengeTtlSeconds: number;
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
    stacksApiUrl: value.STACKS_API_URL.replace(/\/$/, ""),
    stacksBroadcastTimeoutMs: value.STACKS_BROADCAST_TIMEOUT_MS,
    stacksObservationTimeoutMs: value.STACKS_OBSERVATION_TIMEOUT_MS,
    quoteIssuanceEnabled: value.QUOTE_ISSUANCE_ENABLED,
    quoteSigningPrivateJwkJson: value.QUOTE_SIGNING_PRIVATE_JWK_JSON,
    quotePreviousPublicJwksJson: value.QUOTE_PREVIOUS_PUBLIC_JWKS_JSON,
    quoteMaxTtlSeconds: value.QUOTE_MAX_TTL_SECONDS,
    quoteRateLimitPerMinute: value.QUOTE_RATE_LIMIT_PER_MINUTE,
    paymentRateLimitPerMinute: value.PAYMENT_RATE_LIMIT_PER_MINUTE,
    paymentVerificationEnabled: value.PAYMENT_VERIFICATION_ENABLED,
    settlementEnabled: value.SETTLEMENT_ENABLED,
    reconciliationEnabled: value.RECONCILIATION_ENABLED,
    settlementMinConfirmations: value.SETTLEMENT_MIN_CONFIRMATIONS,
    reconciliationBatchSize: value.RECONCILIATION_BATCH_SIZE,
    reconciliationIntervalMs: value.RECONCILIATION_INTERVAL_MS,
    reconciliationLeaseMs: value.RECONCILIATION_LEASE_MS,
    deliveryLedgerEnabled: value.DELIVERY_LEDGER_ENABLED,
    deliveryRetryTtlSeconds: value.DELIVERY_RETRY_TTL_SECONDS,
    oauthEnabled: value.OAUTH_ENABLED,
    partnerRegistrationEnabled: value.PARTNER_REGISTRATION_ENABLED,
    mcpEnabled: value.MCP_ENABLED,
    oauthSigningPrivateJwkJson: value.OAUTH_SIGNING_PRIVATE_JWK_JSON,
    oauthPreviousPublicJwksJson: value.OAUTH_PREVIOUS_PUBLIC_JWKS_JSON,
    oauthAccessTokenTtlSeconds: value.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    partnerChallengeTtlSeconds: value.PARTNER_CHALLENGE_TTL_SECONDS,
    sponsorshipEnabled: value.SPONSORSHIP_ENABLED,
  };
}
