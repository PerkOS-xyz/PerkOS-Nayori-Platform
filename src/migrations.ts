import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { Pool, PoolClient } from "pg";

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_NAME = "perkos-nayori-platform-migrations";

export type MigrationFile = {
  readonly version: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
};

export async function loadMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => MIGRATION_FILE.test(filename))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(directory, filename), "utf8");
      return {
        version: filename.slice(0, 3),
        filename,
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}

async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (version, filename, checksum)
       VALUES ($1, $2, $3)`,
      [migration.version, migration.filename, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(pool: Pool, directory: string): Promise<void> {
  const migrations = await loadMigrationFiles(directory);
  if (migrations.length === 0) {
    throw new Error(`No migration files found in ${basename(directory)}.`);
  }

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        filename text NOT NULL UNIQUE,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await client.query<{
      version: string;
      filename: string;
      checksum: string;
    }>("SELECT version, filename, checksum FROM schema_migrations ORDER BY version");
    const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));

    for (const migration of migrations) {
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.filename !== migration.filename || existing.checksum !== migration.checksum) {
          throw new Error(`Applied migration ${migration.version} does not match the repository.`);
        }
        continue;
      }
      await applyMigration(client, migration);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    } finally {
      client.release();
    }
  }
}
