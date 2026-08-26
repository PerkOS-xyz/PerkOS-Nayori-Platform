import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { consoleLogger } from "./logger.js";

const config = loadConfig();
const database = new PostgresDatabase(config);
const app = createApp({ config, database, logger: consoleLogger });

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
      settlementEnabled: config.settlementEnabled,
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
