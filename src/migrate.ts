import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadConfig } from "./config.js";
import { consoleLogger } from "./logger.js";
import { runMigrations } from "./migrations.js";

const config = loadConfig();
const pool = new Pool({
  application_name: "nayori-migrations",
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: config.databaseConnectTimeoutMs,
  max: 1,
  query_timeout: config.databaseQueryTimeoutMs,
  ssl: config.databaseSsl === "require" ? { rejectUnauthorized: true } : false,
  statement_timeout: config.databaseQueryTimeoutMs,
});

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

try {
  await runMigrations(pool, migrationsDirectory);
  consoleLogger.info({ event: "migrations_complete" });
} catch (error) {
  consoleLogger.error({
    event: "migrations_failed",
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
