import { Pool } from "pg";

import type { AppConfig } from "./config.js";
import {
  parseMerchantRecord,
  type MerchantProvisioning,
  type MerchantRecord,
} from "./merchant.js";

export interface DatabaseHealth {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type IssuedQuoteRecord = {
  readonly quoteId: string;
  readonly merchantId: string;
  readonly audience: string;
  readonly requestMethod: string;
  readonly canonicalUrl: string;
  readonly bodyHash: string;
  readonly network: string;
  readonly assetId: string;
  readonly amountAtomic: string;
  readonly payTo: string;
  readonly fingerprint: string;
  readonly routeConfigHash: string;
  readonly signedTokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

export interface MerchantQuoteStore {
  findActiveMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRecord | null>;
  insertIssuedQuote(record: IssuedQuoteRecord): Promise<void>;
}

export interface MerchantProvisioningStore {
  provisionMerchant(input: MerchantProvisioning, apiKeyHash: string): Promise<void>;
}

export class PostgresDatabase
  implements DatabaseHealth, MerchantQuoteStore, MerchantProvisioningStore
{
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

  async findActiveMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRecord | null> {
    const result = await this.#pool.query(
      `SELECT
         merchant_id AS "merchantId",
         allowed_origins AS "allowedOrigins",
         allowed_audiences AS "allowedAudiences",
         recipient_allowlist AS "recipientAllowlist",
         route_config AS "routeConfig"
       FROM merchants
       WHERE api_key_hash = $1 AND status = 'active'
       LIMIT 1`,
      [apiKeyHash],
    );
    const row = result.rows[0] as unknown;
    return row ? parseMerchantRecord(row) : null;
  }

  async insertIssuedQuote(record: IssuedQuoteRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO quotes (
         quote_id, merchant_id, audience, request_method, canonical_url, body_hash,
         network, asset_id, amount_atomic, pay_to, fingerprint, route_config_hash,
         signed_token_hash, mechanism, status, issued_at, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9::numeric, $10, $11, $12,
         $13, 'stacks-signed-tx-v1', 'issued', $14, $15
       )`,
      [
        record.quoteId,
        record.merchantId,
        record.audience,
        record.requestMethod,
        record.canonicalUrl,
        record.bodyHash,
        record.network,
        record.assetId,
        record.amountAtomic,
        record.payTo,
        record.fingerprint,
        record.routeConfigHash,
        record.signedTokenHash,
        record.issuedAt,
        record.expiresAt,
      ],
    );
  }

  async provisionMerchant(input: MerchantProvisioning, apiKeyHash: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO merchants (
         merchant_id, status, api_key_hash, allowed_origins, allowed_audiences,
         recipient_allowlist, route_config
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
       ON CONFLICT (merchant_id) DO UPDATE SET
         status = EXCLUDED.status,
         api_key_hash = EXCLUDED.api_key_hash,
         allowed_origins = EXCLUDED.allowed_origins,
         allowed_audiences = EXCLUDED.allowed_audiences,
         recipient_allowlist = EXCLUDED.recipient_allowlist,
         route_config = EXCLUDED.route_config,
         updated_at = now()`,
      [
        input.merchantId,
        input.status,
        apiKeyHash,
        JSON.stringify(input.allowedOrigins),
        JSON.stringify(input.allowedAudiences),
        JSON.stringify(input.recipientAllowlist),
        JSON.stringify(input.routeConfig),
      ],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
