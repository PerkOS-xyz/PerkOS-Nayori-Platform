import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { loadBackupOperatorConfig } from "../src/private-evidence-backup-operator-config.js";
import { inspectBackupLedger } from "../src/private-evidence-backup-diagnostics.js";
const env = { S3_BACKUP_QA_ENABLED: "true", S3_EVIDENCE_QA_ENABLED: "true", STACKS_NETWORK: "testnet",
  OAUTH_ISSUER_ORIGIN: "https://oauth.qa.nayori.ai", OAUTH_RESOURCE_ORIGIN: "https://api.qa.nayori.ai", DATABASE_URL: "postgresql://localhost/fixture",
  STACKS_API_URL: "https://api.testnet.hiro.so", S3_EVIDENCE_CONTRACTS: "ST123.contract", S3_EVIDENCE_BUCKET: "perkos-nayori-qa-evidence-123456789012",
  S3_BACKUP_BUCKET: "perkos-nayori-qa-evidence-backup-123456789012", S3_EVIDENCE_REGION: "us-east-1", S3_EVIDENCE_ACCOUNT_ID: "123456789012",
  S3_EVIDENCE_CREDENTIALS_FILE: "/fixture/source.json" };
it("defaults to status and no writes, without backup credentials", () => {
  expect(loadBackupOperatorConfig(env)).toMatchObject({ mode: "status", execute: false, batch: 1 });
});
it.each([{ S3_BACKUP_QA_ENABLED: undefined }, { STACKS_NETWORK: "mainnet" }, { S3_EVIDENCE_CONTRACTS: "SP123.prod" },
  { S3_BACKUP_OPERATION: "restore" }, { S3_BACKUP_BATCH: "11" }, { CONFIRM_QA_BACKUP_WRITES: "yes" },
  { S3_BACKUP_BUCKET: env.S3_EVIDENCE_BUCKET }, { S3_EVIDENCE_BUCKET: "production-bucket" },
  { S3_BACKUP_OPERATION: "reconcile" }, { CONFIRM_QA_BACKUP_WRITES: "true" }])("rejects unsafe configuration %#", change => {
  expect(() => loadBackupOperatorConfig({ ...env, ...change })).toThrow();
});
it("selects separate credentials by operation and requires exact write confirmation", () => {
  const files = { S3_BACKUP_WRITER_CREDENTIALS_FILE: "/fixture/writer.json", S3_BACKUP_CLEANUP_CREDENTIALS_FILE: "/fixture/cleanup.json" };
  expect(loadBackupOperatorConfig({ ...env, ...files, S3_BACKUP_OPERATION: "reconcile" })).toMatchObject({ backupFile: files.S3_BACKUP_WRITER_CREDENTIALS_FILE, execute: false });
  expect(loadBackupOperatorConfig({ ...env, ...files, S3_BACKUP_OPERATION: "retire", CONFIRM_QA_BACKUP_WRITES: "yes" })).toMatchObject({ backupFile: files.S3_BACKUP_CLEANUP_CREDENTIALS_FILE, execute: true });
  expect(() => loadBackupOperatorConfig({ ...env, ...files, S3_BACKUP_OPERATION: "reconcile", S3_BACKUP_WRITER_CREDENTIALS_FILE: env.S3_EVIDENCE_CREDENTIALS_FILE })).toThrow();
});
const id = "11111111-1111-4111-8111-111111111111";
const expected = { sourceKey: `private-evidence/testnet/${id}`, sourceVersion: "original", sha256: "a".repeat(64), sizeBytes: 7, mediaType: "text/plain", expiresAt: 10000 };
it("reports quarantine and corruption without revealing row data", async () => {
  const pool = { query: vi.fn(async () => ({ rows: [
    { expected, state: "pending", contract: null, manifest: null },
    { expected: { sourceKey: "secret-object-key" }, state: "pending", contract: "ST123.contract", manifest: null },
    { expected, state: "verified", contract: "ST123.contract", manifest: null },
  ] })) } as unknown as Pool;
  const r = await inspectBackupLedger(pool, ["ST123.contract"]);
  expect(r).toEqual({ inspected: 3, truncated: false, quarantined: 1, inconsistent: 2, pending: 2, verified: 1 });
  expect(JSON.stringify(r)).not.toContain("secret-object-key");
});
it("marks a capped inspection incomplete instead of declaring all rows valid", async () => {
  const pool = { query: async () => ({ rows: Array.from({ length: 101 }, () => ({ expected, state: "pending", contract: "ST123.contract", manifest: null })) }) } as unknown as Pool;
  expect(await inspectBackupLedger(pool, ["ST123.contract"])).toMatchObject({ inspected: 100, truncated: true });
});
