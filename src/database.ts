import { Pool } from "pg";

import type { AppConfig } from "./config.js";

export interface DatabaseHealth {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class PostgresDatabase implements DatabaseHealth {
  readonly #pool: Pool;

  constructor(config: AppConfig) {
    this.#pool = new Pool({
      application_name: "nayori-facilitator",
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: config.databaseConnectTimeoutMs,
      max: config.databasePoolMax,
      query_timeout: config.databaseQueryTimeoutMs,
      ssl: config.databaseSsl === "require" ? { rejectUnauthorized: true } : false,
      statement_timeout: config.databaseQueryTimeoutMs,
    });
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
