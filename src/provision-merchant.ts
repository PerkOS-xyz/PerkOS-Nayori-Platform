import { createNayoriX402Quote } from "@perkos/agent-sdk";

import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import {
  generateMerchantApiKey,
  hashMerchantApiKey,
  merchantProvisioningSchema,
} from "./merchant.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseJsonEnvironment(name: string): unknown {
  try {
    return JSON.parse(requiredEnvironment(name)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${name} must contain valid JSON.`, { cause: error });
    }
    throw error;
  }
}

const config = loadConfig();
const input = merchantProvisioningSchema.parse({
  merchantId: requiredEnvironment("MERCHANT_ID"),
  status: process.env.MERCHANT_STATUS ?? "active",
  allowedOrigins: parseJsonEnvironment("MERCHANT_ALLOWED_ORIGINS_JSON"),
  allowedAudiences: parseJsonEnvironment("MERCHANT_ALLOWED_AUDIENCES_JSON"),
  recipientAllowlist: parseJsonEnvironment("MERCHANT_RECIPIENT_ALLOWLIST_JSON"),
  routeConfig: parseJsonEnvironment("MERCHANT_ROUTE_CONFIG_JSON"),
});

for (const [routeId, route] of Object.entries(input.routeConfig.routes)) {
  if (route.network !== config.stacksNetwork) {
    throw new Error(`Merchant route ${routeId} does not match STACKS_NETWORK.`);
  }
  if (!input.allowedAudiences.includes(route.audience)) {
    throw new Error(`Merchant route ${routeId} uses a non-allowlisted audience.`);
  }
  if (!input.recipientAllowlist.includes(route.payTo)) {
    throw new Error(`Merchant route ${routeId} uses a non-allowlisted recipient.`);
  }
  await createNayoriX402Quote({
    quoteId: `validation-${routeId}`,
    merchantId: input.merchantId,
    method: route.method,
    url: `${input.allowedOrigins[0]}${route.pathPrefix}`,
    network: route.network,
    asset: route.asset,
    amount: route.amount,
    payTo: route.payTo,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_000 + route.ttlSeconds,
  });
}

const apiKey = generateMerchantApiKey();
const database = new PostgresDatabase(config);
try {
  await database.provisionMerchant(input, hashMerchantApiKey(apiKey));
  console.log(
    JSON.stringify(
      {
        merchantId: input.merchantId,
        apiKey,
        warning: "This API key is shown once. Store it in the merchant secret manager.",
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
}
