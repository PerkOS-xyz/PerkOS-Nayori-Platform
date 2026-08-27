import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createHiroTransactionBroadcaster } from "./broadcast.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { consoleLogger } from "./logger.js";
import { createQuoteSigner } from "./quote-signing.js";
import { createQuoteService } from "./quotes.js";
import { createSettlementService } from "./settlement.js";

const config = loadConfig();
const database = new PostgresDatabase(config);
const quoteSigner = config.quoteIssuanceEnabled ? await createQuoteSigner(config) : undefined;
const quoteService = config.quoteIssuanceEnabled
  ? createQuoteService({ config, store: database, signer: quoteSigner! })
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
    })
  : undefined;
const app = createApp({
  config,
  database,
  logger: consoleLogger,
  quoteService,
  settlementService,
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
