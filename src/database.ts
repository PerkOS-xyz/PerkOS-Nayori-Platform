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

export type StoredQuoteRecord = IssuedQuoteRecord & {
  readonly status: "issued" | "reserved" | "consumed" | "expired" | "revoked";
};

export type SettlementStatus =
  | "validated"
  | "broadcast"
  | "pending"
  | "confirmed"
  | "failed"
  | "dropped"
  | "reorged";

export type SettlementRecord = {
  readonly settlementId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly network: string;
  readonly txid: string;
  readonly payer: string;
  readonly rawTxHash: string;
  readonly verifierVersion: string;
  readonly verifierChecksum: string;
  readonly status: SettlementStatus;
  readonly failureReason: string | null;
  readonly broadcastAttemptedAt: Date | null;
  readonly broadcastAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type SettlementReservation = {
  readonly settlementId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly network: string;
  readonly txid: string;
  readonly payer: string;
  readonly rawTxHash: string;
  readonly verifierVersion: string;
  readonly verifierChecksum: string;
  readonly expectedSignedTokenHash: string;
};

export type ReserveSettlementResult = {
  readonly created: boolean;
  readonly settlement: SettlementRecord;
};

export class SettlementStoreError extends Error {
  constructor(readonly code: "quote_unavailable" | "payment_replayed") {
    super(code);
    this.name = "SettlementStoreError";
  }
}

export interface MerchantQuoteStore {
  findActiveMerchantByApiKeyHash(apiKeyHash: string): Promise<MerchantRecord | null>;
  insertIssuedQuote(record: IssuedQuoteRecord): Promise<void>;
}

export interface SettlementStore {
  findStoredQuote(quoteId: string, merchantId: string): Promise<StoredQuoteRecord | null>;
  reserveSettlement(input: SettlementReservation): Promise<ReserveSettlementResult>;
  updateSettlementStatus(
    settlementId: string,
    fromStatus: "validated",
    toStatus: "broadcast" | "pending" | "failed",
    reasonCode: string | null,
    attemptedAt: Date,
  ): Promise<SettlementRecord>;
  findSettlementForMerchant(
    settlementId: string,
    merchantId: string,
  ): Promise<SettlementRecord | null>;
}

export interface MerchantProvisioningStore {
  provisionMerchant(input: MerchantProvisioning, apiKeyHash: string): Promise<void>;
}

export class PostgresDatabase
  implements DatabaseHealth, MerchantQuoteStore, MerchantProvisioningStore, SettlementStore
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

  async findStoredQuote(quoteId: string, merchantId: string): Promise<StoredQuoteRecord | null> {
    const result = await this.#pool.query(
      `SELECT
         quote_id AS "quoteId",
         merchant_id AS "merchantId",
         audience,
         request_method AS "requestMethod",
         canonical_url AS "canonicalUrl",
         body_hash AS "bodyHash",
         network,
         asset_id AS "assetId",
         amount_atomic::text AS "amountAtomic",
         pay_to AS "payTo",
         fingerprint,
         route_config_hash AS "routeConfigHash",
         signed_token_hash AS "signedTokenHash",
         status,
         issued_at AS "issuedAt",
         expires_at AS "expiresAt"
       FROM quotes
       WHERE quote_id = $1 AND merchant_id = $2
       LIMIT 1`,
      [quoteId, merchantId],
    );
    return (result.rows[0] as StoredQuoteRecord | undefined) ?? null;
  }

  async reserveSettlement(input: SettlementReservation): Promise<ReserveSettlementResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const quote = await client.query<{
        status: StoredQuoteRecord["status"];
        signedTokenHash: string;
        expiresAt: Date;
      }>(
        `SELECT
           status,
           signed_token_hash AS "signedTokenHash",
           expires_at AS "expiresAt"
         FROM quotes
         WHERE quote_id = $1 AND merchant_id = $2
         FOR UPDATE`,
        [input.quoteId, input.merchantId],
      );
      const locked = quote.rows[0];
      if (!locked || locked.signedTokenHash !== input.expectedSignedTokenHash) {
        throw new SettlementStoreError("quote_unavailable");
      }

      const existing = await client.query(
        `${SETTLEMENT_SELECT}
         WHERE s.quote_id = $1 AND q.merchant_id = $2
         LIMIT 1`,
        [input.quoteId, input.merchantId],
      );
      if (existing.rows[0]) {
        const settlement = existing.rows[0] as SettlementRecord;
        if (settlement.txid !== input.txid || settlement.rawTxHash !== input.rawTxHash) {
          throw new SettlementStoreError("payment_replayed");
        }
        await client.query("COMMIT");
        return { created: false, settlement };
      }

      if (locked.status !== "issued" || locked.expiresAt.getTime() < Date.now()) {
        throw new SettlementStoreError("quote_unavailable");
      }
      const duplicate = await client.query(
        `SELECT settlement_id
         FROM settlements
         WHERE network = $1 AND txid = $2
         LIMIT 1`,
        [input.network, input.txid],
      );
      if (duplicate.rows[0]) throw new SettlementStoreError("payment_replayed");

      await client.query(
        `INSERT INTO settlements (
           settlement_id, quote_id, network, txid, payer, raw_tx_hash,
           verifier_version, verifier_checksum, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'validated')`,
        [
          input.settlementId,
          input.quoteId,
          input.network,
          input.txid,
          input.payer,
          input.rawTxHash,
          input.verifierVersion,
          input.verifierChecksum,
        ],
      );
      await client.query(
        `INSERT INTO settlement_transitions (settlement_id, from_status, to_status, reason_code)
         VALUES ($1, NULL, 'validated', 'payment_verified')`,
        [input.settlementId],
      );
      await client.query(
        `UPDATE quotes SET status = 'reserved', updated_at = now() WHERE quote_id = $1`,
        [input.quoteId],
      );
      const created = await client.query(
        `${SETTLEMENT_SELECT}
         WHERE s.settlement_id = $1 AND q.merchant_id = $2
         LIMIT 1`,
        [input.settlementId, input.merchantId],
      );
      await client.query("COMMIT");
      return { created: true, settlement: created.rows[0] as SettlementRecord };
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error instanceof SettlementStoreError ||
        (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
      ) {
        if (error instanceof SettlementStoreError) throw error;
        throw new SettlementStoreError("payment_replayed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSettlementStatus(
    settlementId: string,
    fromStatus: "validated",
    toStatus: "broadcast" | "pending" | "failed",
    reasonCode: string | null,
    attemptedAt: Date,
  ): Promise<SettlementRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE settlements
         SET status = $3,
             failure_reason = $4,
             broadcast_attempted_at = $5,
             broadcast_at = CASE WHEN $3 = 'broadcast' THEN $5 ELSE broadcast_at END,
             updated_at = now()
         WHERE settlement_id = $1 AND status = $2
         RETURNING settlement_id`,
        [settlementId, fromStatus, toStatus, reasonCode, attemptedAt],
      );
      if (updated.rowCount !== 1) {
        throw new Error("The settlement status transition was not applied.");
      }
      await client.query(
        `INSERT INTO settlement_transitions (settlement_id, from_status, to_status, reason_code)
         VALUES ($1, $2, $3, $4)`,
        [settlementId, fromStatus, toStatus, reasonCode],
      );
      const result = await client.query(
        `${SETTLEMENT_SELECT}
         WHERE s.settlement_id = $1
         LIMIT 1`,
        [settlementId],
      );
      await client.query("COMMIT");
      return result.rows[0] as SettlementRecord;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findSettlementForMerchant(
    settlementId: string,
    merchantId: string,
  ): Promise<SettlementRecord | null> {
    const result = await this.#pool.query(
      `${SETTLEMENT_SELECT}
       WHERE s.settlement_id = $1 AND q.merchant_id = $2
       LIMIT 1`,
      [settlementId, merchantId],
    );
    return (result.rows[0] as SettlementRecord | undefined) ?? null;
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

const SETTLEMENT_SELECT = `SELECT
  s.settlement_id AS "settlementId",
  s.quote_id AS "quoteId",
  q.merchant_id AS "merchantId",
  s.network,
  s.txid,
  s.payer,
  s.raw_tx_hash AS "rawTxHash",
  s.verifier_version AS "verifierVersion",
  s.verifier_checksum AS "verifierChecksum",
  s.status,
  s.failure_reason AS "failureReason",
  s.broadcast_attempted_at AS "broadcastAttemptedAt",
  s.broadcast_at AS "broadcastAt",
  s.created_at AS "createdAt",
  s.updated_at AS "updatedAt"
FROM settlements s
JOIN quotes q ON q.quote_id = s.quote_id`;
