import { loadConfig } from "./config.js";
import { PostgresDatabase } from "./database.js";
import { consoleLogger } from "./logger.js";
import { createQuoteSigner } from "./quote-signing.js";
import {
  createHiroSettlementChainSource,
  createReconciliationService,
} from "./reconciliation.js";

const config = loadConfig();
if (!config.reconciliationEnabled) {
  throw new Error("The reconciliation worker cannot start while reconciliation is disabled.");
}

const database = new PostgresDatabase(config);
const service = createReconciliationService({
  config,
  store: database,
  signer: await createQuoteSigner(config),
  source: createHiroSettlementChainSource({ config }),
});

let stopping = false;
let wakeFromInterval: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    wakeFromInterval?.();
    consoleLogger.info({ event: "reconciliation_worker_stopping", signal });
  });
}

async function waitForNextBatch(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeFromInterval = undefined;
      resolve();
    }, config.reconciliationIntervalMs);
    wakeFromInterval = () => {
      clearTimeout(timer);
      wakeFromInterval = undefined;
      resolve();
    };
  });
}

try {
  consoleLogger.info({
    event: "reconciliation_worker_started",
    release: config.releaseSha,
    minConfirmations: config.settlementMinConfirmations,
  });
  while (!stopping) {
    try {
      const result = await service.runOnce();
      consoleLogger.info({ event: "reconciliation_batch_completed", ...result });
    } catch (error) {
      consoleLogger.error({
        event: "reconciliation_batch_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    if (!stopping) {
      await waitForNextBatch();
    }
  }
} finally {
  await database.close();
  consoleLogger.info({ event: "reconciliation_worker_stopped" });
}
