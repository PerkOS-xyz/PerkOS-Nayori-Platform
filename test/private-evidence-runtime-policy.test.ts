import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDirectEvidenceConfig } from "../src/private-evidence-direct-runtime.js";
import { loadEvidenceCredentials } from "../src/private-evidence-credentials.js";
import { createEvidenceAdmission, EVIDENCE_RETENTION_SECONDS, EVIDENCE_BACKUP_GRACE_SECONDS } from "../src/private-evidence-policy.js";

const env = { S3_EVIDENCE_QA_ENABLED: "true", STACKS_NETWORK: "testnet", OAUTH_ISSUER_ORIGIN: "https://oauth.qa.nayori.ai",
  OAUTH_RESOURCE_ORIGIN: "https://api.qa.nayori.ai", DATABASE_URL: "postgresql://fixture@localhost/fixture",
  STACKS_API_URL: "https://api.testnet.hiro.so", S3_EVIDENCE_CONTRACTS: "ST16EWRC01S1SFWGBP63MW47VY8P3AYFA8VGEBGE5.sbtc-commerce-v5",
  S3_EVIDENCE_BUCKET: "fixture-qa-bucket", S3_EVIDENCE_REGION: "us-east-1", S3_EVIDENCE_ACCOUNT_ID: "123456789012",
  S3_EVIDENCE_CREDENTIALS_FILE: "/fixture/credentials.json" };
describe("QA direct evidence configuration and admission", () => {
  it("is disabled by default, requires explicit enable and accepts QA only", () => {
    expect(loadDirectEvidenceConfig({})).toBeNull(); expect(loadDirectEvidenceConfig({ S3_EVIDENCE_QA_ENABLED: "false" })).toBeNull();
    expect(loadDirectEvidenceConfig(env)?.network).toBe("testnet");
    expect(EVIDENCE_RETENTION_SECONDS).toBe(2592000); expect(EVIDENCE_BACKUP_GRACE_SECONDS).toBe(604800);
  });
  it.each([
    { STACKS_NETWORK: "mainnet" }, { OAUTH_ISSUER_ORIGIN: "https://oauth.nayori.ai" },
    { OAUTH_RESOURCE_ORIGIN: "https://nayori.ai" }, { STACKS_API_URL: "https://api.hiro.so" },
    { S3_EVIDENCE_QA_ENABLED: "yes" }, { S3_EVIDENCE_CREDENTIALS_FILE: "" }, { S3_EVIDENCE_ACCOUNT_ID: "" },
  ])("denies unsafe runtime config %j", change => expect(() => loadDirectEvidenceConfig({ ...env, ...change })).toThrow());
  it("bounds preparations per wallet and resets after a minute", () => {
    let now = 0; const admit = createEvidenceAdmission(() => now);
    for (let i=0;i<10;i++) expect(admit("wallet", "prepare")).toBe(true);
    expect(admit("wallet", "prepare")).toBe(false); expect(admit("other", "prepare")).toBe(true);
    expect(admit("wallet", "complete")).toBe(true); now=60000; expect(admit("wallet", "prepare")).toBe(true);
  });
  it("requires a real owner-only file, rejects symlinks and never falls back to environment", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "nayori-aws-fixture-")));
    const file = join(dir, "fixture.json");
    try {
      await writeFile(file, JSON.stringify({ accessKeyId: "A".repeat(20), secretAccessKey: "s".repeat(40) }), { mode: 0o600 });
      expect((await loadEvidenceCredentials(file)).accessKeyId).toBe("A".repeat(20));
      await chmod(file, 0o644); await expect(loadEvidenceCredentials(file)).rejects.toThrow("private_evidence_credentials_invalid");
      await chmod(file, 0o600); await symlink(file, join(dir, "link")); await expect(loadEvidenceCredentials(join(dir,"link"))).rejects.toThrow();
      await writeFile(file, "x".repeat(9000)); await expect(loadEvidenceCredentials(file)).rejects.toThrow();
      await expect(loadEvidenceCredentials(join(dir,"absent"))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
