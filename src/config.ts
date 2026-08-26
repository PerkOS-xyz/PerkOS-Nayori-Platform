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

const environmentSchema = z.object({
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
  SETTLEMENT_ENABLED: disabledFeatureFlag,
  SPONSORSHIP_ENABLED: disabledFeatureFlag,
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
    settlementEnabled: value.SETTLEMENT_ENABLED,
    sponsorshipEnabled: value.SPONSORSHIP_ENABLED,
  };
}
