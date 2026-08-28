import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createHiroTransactionBroadcaster } from "./broadcast.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { createExternalOAuthAuthenticator } from "./external-oauth.js";
import { createFacilitatorClient } from "./facilitator-client.js";
import { consoleLogger } from "./logger.js";
import { createMcpService } from "./mcp.js";
import { createMppResourceService } from "./mpp-resource.js";
import { createOAuthService, createOAuthSigner } from "./oauth.js";
import { createPaidResourceService } from "./paid-resource.js";
import { createQuoteSigner } from "./quote-signing.js";
import { createQuoteService } from "./quotes.js";
import { createSettlementService } from "./settlement.js";

const config = loadConfig();
const database = new PostgresDatabase(config);
const quoteSigner = config.quoteIssuanceEnabled ? await createQuoteSigner(config) : undefined;
const oauthSigner = config.oauthEnabled && config.oauthMode === "embedded"
  ? await createOAuthSigner(config)
  : undefined;
const oauthService = config.oauthEnabled && config.oauthMode === "embedded"
  ? createOAuthService({ config, store: database, signer: oauthSigner! })
  : undefined;
const oauthAuthenticator = config.oauthEnabled
  ? config.oauthMode === "external"
    ? createExternalOAuthAuthenticator({ config, store: database })
    : oauthService!
  : undefined;
const quoteService = config.quoteIssuanceEnabled
  ? createQuoteService({
      config,
      store: database,
      signer: quoteSigner!,
      ...(oauthAuthenticator ? { authenticator: oauthAuthenticator } : {}),
    })
  : undefined;
const settlementService = config.paymentVerificationEnabled
  ? createSettlementService({
      config,
      store: database,
      signer: quoteSigner!,
      ...(config.settlementEnabled
        ? { broadcaster: createHiroTransactionBroadcaster({ config }) }
        : {}),
      ...(config.deliveryLedgerEnabled ? { deliveryStore: database } : {}),
      ...(oauthAuthenticator ? { authenticator: oauthAuthenticator } : {}),
    })
  : undefined;
const mcpService = config.mcpEnabled
  ? createMcpService({
      config,
      authenticator: oauthAuthenticator!,
      quoteService,
      settlementService,
    })
  : undefined;
const paidResourceService = config.publicResourceEnabled
  ? createPaidResourceService({
      config,
      facilitator: createFacilitatorClient({
        origin: config.facilitatorOrigin,
        merchantApiKey: config.facilitatorMerchantApiKey!,
        timeoutMs: config.facilitatorRequestTimeoutMs,
      }),
    })
  : undefined;
const mppResourceService = config.mppResourceEnabled
  ? createMppResourceService({
      config,
      facilitator: createFacilitatorClient({
        origin: config.facilitatorOrigin,
        merchantApiKey: config.facilitatorMerchantApiKey!,
        timeoutMs: config.facilitatorRequestTimeoutMs,
      }),
    })
  : undefined;
const app = createApp({
  config,
  database,
  logger: consoleLogger,
  quoteService,
  settlementService,
  oauthService,
  mcpService,
  paidResourceService,
  mppResourceService,
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    consoleLogger.info({
      event: "server_started",
      address: info.address,
      port: info.port,
      release: config.releaseSha,
      quoteIssuanceEnabled: config.quoteIssuanceEnabled,
      paymentVerificationEnabled: config.paymentVerificationEnabled,
      settlementEnabled: config.settlementEnabled,
      reconciliationEnabled: config.reconciliationEnabled,
      deliveryLedgerEnabled: config.deliveryLedgerEnabled,
      oauthEnabled: config.oauthEnabled,
      oauthMode: config.oauthMode,
      partnerRegistrationEnabled: config.partnerRegistrationEnabled,
      mcpEnabled: config.mcpEnabled,
      publicResourceEnabled: config.publicResourceEnabled,
      publicResourceUrl: config.publicResourceEnabled ? config.publicResourceUrl : undefined,
      mppResourceEnabled: config.mppResourceEnabled,
      mppResourceUrl: config.mppResourceEnabled ? config.mppResourceUrl : undefined,
      facilitatorOrigin:
        config.publicResourceEnabled || config.mppResourceEnabled
          ? config.facilitatorOrigin
          : undefined,
      sponsorshipEnabled: config.sponsorshipEnabled,
    });
  },
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  consoleLogger.info({ event: "server_stopping", signal });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await database.close();
  consoleLogger.info({ event: "server_stopped" });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      consoleLogger.error({
        event: "shutdown_failed",
        signal,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      process.exitCode = 1;
    });
  });
}
