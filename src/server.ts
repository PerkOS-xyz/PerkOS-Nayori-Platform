import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createHiroTransactionBroadcaster } from "./broadcast.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { consoleLogger } from "./logger.js";
import { createMcpService } from "./mcp.js";
import { createOAuthService, createOAuthSigner } from "./oauth.js";
import { createQuoteSigner } from "./quote-signing.js";
import { createQuoteService } from "./quotes.js";
import { createSettlementService } from "./settlement.js";

const config = loadConfig();
const database = new PostgresDatabase(config);
const quoteSigner = config.quoteIssuanceEnabled ? await createQuoteSigner(config) : undefined;
const oauthSigner = config.oauthEnabled ? await createOAuthSigner(config) : undefined;
const oauthService = config.oauthEnabled
  ? createOAuthService({ config, store: database, signer: oauthSigner! })
  : undefined;
const quoteService = config.quoteIssuanceEnabled
  ? createQuoteService({
      config,
      store: database,
      signer: quoteSigner!,
      ...(oauthService ? { authenticator: oauthService } : {}),
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
      ...(oauthService ? { authenticator: oauthService } : {}),
    })
  : undefined;
const mcpService = config.mcpEnabled
  ? createMcpService({
      config,
      authenticator: oauthService!,
      quoteService,
      settlementService,
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
      partnerRegistrationEnabled: config.partnerRegistrationEnabled,
      mcpEnabled: config.mcpEnabled,
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
