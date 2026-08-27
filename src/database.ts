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
  readonly receiptId?: string | null;
  readonly receiptToken?: string | null;
  readonly deliveryId?: string | null;
  readonly deliveryStatus?: DeliveryStatus | null;
  readonly responseDigest?: string | null;
};

export type ReconciliationCandidate = SettlementRecord & {
  readonly audience: string;
  readonly requestMethod: string;
  readonly canonicalUrl: string;
  readonly bodyHash: string;
  readonly assetId: string;
  readonly amountAtomic: string;
  readonly payTo: string;
};

export type ConfirmationReceiptRecord = {
  readonly receiptId: string;
  readonly settlementId: string;
  readonly keyId: string;
  readonly payloadHash: string;
  readonly tokenHash: string;
  readonly signedToken: string;
  readonly issuedAt: Date;
};

export type DeliveryStatus =
  | "delivery_pending"
  | "delivering"
  | "delivered"
  | "failed"
  | "expired";

export type DeliveryLedgerRecord = {
  readonly deliveryId: string;
  readonly settlementId: string;
  readonly merchantId: string;
  readonly status: DeliveryStatus;
  readonly attemptCount: number;
  readonly responseDigest: string | null;
  readonly retryExpiresAt: Date;
  readonly receiptId: string;
  readonly receiptToken: string;
};

export type ReconciliationResultInput =
  | {
      readonly outcome: "pending";
      readonly settlementId: string;
      readonly checkedAt: Date;
      readonly retryAt: Date;
      readonly reasonCode: string;
    }
  | {
      readonly outcome: "terminal";
      readonly settlementId: string;
      readonly checkedAt: Date;
      readonly status: "failed" | "dropped";
      readonly reasonCode: string;
    }
  | {
      readonly outcome: "confirmed";
      readonly settlementId: string;
      readonly checkedAt: Date;
      readonly blockHeight: number;
      readonly blockHash: string;
      readonly confirmations: number;
      readonly receipt: ConfirmationReceiptRecord;
      readonly deliveryId: string;
      readonly requestDigest: string;
      readonly deliveryRetryExpiresAt: Date;
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

export interface ReconciliationStore {
  claimSettlementsForReconciliation(
    limit: number,
    claimedAt: Date,
    leaseUntil: Date,
  ): Promise<readonly ReconciliationCandidate[]>;
  applyReconciliationResult(input: ReconciliationResultInput): Promise<SettlementRecord>;
}

export class DeliveryStoreError extends Error {
  constructor(
    readonly code:
      | "delivery_not_found"
      | "settlement_not_confirmed"
      | "delivery_expired"
      | "delivery_not_claimed"
      | "delivery_digest_conflict",
  ) {
    super(code);
    this.name = "DeliveryStoreError";
  }
}

export interface DeliveryLedgerStore {
  claimDelivery(
    settlementId: string,
    merchantId: string,
    claimedAt: Date,
  ): Promise<DeliveryLedgerRecord>;
  completeDelivery(
    settlementId: string,
    merchantId: string,
    responseDigest: string,
    completedAt: Date,
  ): Promise<DeliveryLedgerRecord>;
}

export interface MerchantProvisioningStore {
  provisionMerchant(input: MerchantProvisioning, apiKeyHash: string): Promise<void>;
}

export class PostgresDatabase
  implements
    DatabaseHealth,
    MerchantQuoteStore,
    MerchantProvisioningStore,
    SettlementStore,
    ReconciliationStore,
    DeliveryLedgerStore
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

  async claimSettlementsForReconciliation(
    limit: number,
    claimedAt: Date,
    leaseUntil: Date,
  ): Promise<readonly ReconciliationCandidate[]> {
    const result = await this.#pool.query<{ settlementId: string }>(
      `WITH candidates AS (
         SELECT settlement_id
         FROM settlements
         WHERE status IN ('validated', 'broadcast', 'pending')
           AND reconcile_after <= $2
           AND (reconcile_lease_until IS NULL OR reconcile_lease_until <= $2)
         ORDER BY reconcile_after, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE settlements s
       SET reconcile_lease_until = $3,
           reconcile_attempt_count = reconcile_attempt_count + 1,
           updated_at = now()
       FROM candidates c
       WHERE s.settlement_id = c.settlement_id
       RETURNING s.settlement_id AS "settlementId"`,
      [limit, claimedAt, leaseUntil],
    );
    const ids = result.rows.map((row) => row.settlementId);
    if (ids.length === 0) return [];
    const candidates = await this.#pool.query(
      `${RECONCILIATION_SELECT}
       WHERE s.settlement_id = ANY($1::varchar[])`,
      [ids],
    );
    return candidates.rows as ReconciliationCandidate[];
  }

  async applyReconciliationResult(input: ReconciliationResultInput): Promise<SettlementRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        status: SettlementStatus;
        quoteId: string;
        failureReason: string | null;
      }>(
        `SELECT status, quote_id AS "quoteId", failure_reason AS "failureReason"
         FROM settlements
         WHERE settlement_id = $1
         FOR UPDATE`,
        [input.settlementId],
      );
      const current = locked.rows[0];
      if (!current) throw new Error("The reconciliation settlement does not exist.");
      if (!["validated", "broadcast", "pending"].includes(current.status)) {
        const existing = await client.query(
          `${SETTLEMENT_SELECT} WHERE s.settlement_id = $1 LIMIT 1`,
          [input.settlementId],
        );
        await client.query("COMMIT");
        return existing.rows[0] as SettlementRecord;
      }

      if (input.outcome === "pending") {
        await client.query(
          `UPDATE settlements
           SET status = 'pending',
               failure_reason = $2,
               broadcast_attempted_at = COALESCE(broadcast_attempted_at, $3),
               last_checked_at = $3,
               reconcile_after = $4,
               reconcile_lease_until = NULL,
               updated_at = now()
           WHERE settlement_id = $1`,
          [input.settlementId, input.reasonCode, input.checkedAt, input.retryAt],
        );
        if (current.status !== "pending" || current.failureReason !== input.reasonCode) {
          await client.query(
            `INSERT INTO settlement_transitions (settlement_id, from_status, to_status, reason_code)
             VALUES ($1, $2, 'pending', $3)`,
            [input.settlementId, current.status, input.reasonCode],
          );
        }
      } else if (input.outcome === "terminal") {
        await client.query(
          `UPDATE settlements
           SET status = $2,
               failure_reason = $3,
               broadcast_attempted_at = COALESCE(broadcast_attempted_at, $4),
               last_checked_at = $4,
               reconcile_lease_until = NULL,
               updated_at = now()
           WHERE settlement_id = $1`,
          [input.settlementId, input.status, input.reasonCode, input.checkedAt],
        );
        await client.query(
          `INSERT INTO settlement_transitions (settlement_id, from_status, to_status, reason_code)
           VALUES ($1, $2, $3, $4)`,
          [input.settlementId, current.status, input.status, input.reasonCode],
        );
      } else {
        await client.query(
          `UPDATE settlements
           SET status = 'confirmed',
               failure_reason = NULL,
               broadcast_attempted_at = COALESCE(broadcast_attempted_at, $2),
               confirmed_at = $2,
               confirmed_block_height = $3,
               confirmed_block_hash = $4,
               last_checked_at = $2,
               reconcile_lease_until = NULL,
               updated_at = now()
           WHERE settlement_id = $1`,
          [input.settlementId, input.checkedAt, input.blockHeight, input.blockHash],
        );
        await client.query(
          `UPDATE quotes SET status = 'consumed', updated_at = now() WHERE quote_id = $1`,
          [current.quoteId],
        );
        await client.query(
          `INSERT INTO settlement_receipts (
             receipt_id, settlement_id, key_id, payload_hash, token_hash, signed_token, issued_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.receipt.receiptId,
            input.receipt.settlementId,
            input.receipt.keyId,
            input.receipt.payloadHash,
            input.receipt.tokenHash,
            input.receipt.signedToken,
            input.receipt.issuedAt,
          ],
        );
        await client.query(
          `INSERT INTO deliveries (
             delivery_id, settlement_id, request_digest, status, retry_expires_at
           ) VALUES ($1, $2, $3, 'delivery_pending', $4)`,
          [
            input.deliveryId,
            input.settlementId,
            input.requestDigest,
            input.deliveryRetryExpiresAt,
          ],
        );
        await client.query(
          `INSERT INTO settlement_transitions (
             settlement_id, from_status, to_status, reason_code, metadata
           ) VALUES ($1, $2, 'confirmed', 'confirmation_depth_reached', $3::jsonb)`,
          [
            input.settlementId,
            current.status,
            JSON.stringify({
              blockHeight: input.blockHeight,
              blockHash: input.blockHash,
              confirmations: input.confirmations,
              receiptId: input.receipt.receiptId,
            }),
          ],
        );
      }

      const result = await client.query(
        `${SETTLEMENT_SELECT} WHERE s.settlement_id = $1 LIMIT 1`,
        [input.settlementId],
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

  async claimDelivery(
    settlementId: string,
    merchantId: string,
    claimedAt: Date,
  ): Promise<DeliveryLedgerRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `${DELIVERY_SELECT}
         WHERE d.settlement_id = $1 AND q.merchant_id = $2
         FOR UPDATE OF d`,
        [settlementId, merchantId],
      );
      const delivery = result.rows[0] as DeliveryLedgerRecord | undefined;
      if (!delivery) throw new DeliveryStoreError("delivery_not_found");
      if (delivery.status === "delivery_pending" && delivery.retryExpiresAt < claimedAt) {
        await client.query(
          `UPDATE deliveries SET status = 'expired', updated_at = now() WHERE delivery_id = $1`,
          [delivery.deliveryId],
        );
      } else if (delivery.status === "delivery_pending") {
        await client.query(
          `UPDATE deliveries
           SET status = 'delivering',
               attempt_count = attempt_count + 1,
               delivery_started_at = COALESCE(delivery_started_at, $2),
               updated_at = now()
           WHERE delivery_id = $1`,
          [delivery.deliveryId, claimedAt],
        );
      } else if (!["delivering", "delivered"].includes(delivery.status)) {
        throw new DeliveryStoreError(
          delivery.status === "expired" ? "delivery_expired" : "delivery_not_found",
        );
      }
      const updated = await client.query(
        `${DELIVERY_SELECT} WHERE d.delivery_id = $1 LIMIT 1`,
        [delivery.deliveryId],
      );
      await client.query("COMMIT");
      return updated.rows[0] as DeliveryLedgerRecord;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeDelivery(
    settlementId: string,
    merchantId: string,
    responseDigest: string,
    completedAt: Date,
  ): Promise<DeliveryLedgerRecord> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `${DELIVERY_SELECT}
         WHERE d.settlement_id = $1 AND q.merchant_id = $2
         FOR UPDATE OF d`,
        [settlementId, merchantId],
      );
      const delivery = result.rows[0] as DeliveryLedgerRecord | undefined;
      if (!delivery) throw new DeliveryStoreError("delivery_not_found");
      if (delivery.status === "delivered") {
        if (delivery.responseDigest !== responseDigest) {
          throw new DeliveryStoreError("delivery_digest_conflict");
        }
        await client.query("COMMIT");
        return delivery;
      }
      if (delivery.status !== "delivering") {
        throw new DeliveryStoreError("delivery_not_claimed");
      }
      await client.query(
        `UPDATE deliveries
         SET status = 'delivered',
             response_digest = $2,
             delivery_completed_at = $3,
             updated_at = now()
         WHERE delivery_id = $1`,
        [delivery.deliveryId, responseDigest, completedAt],
      );
      const updated = await client.query(
        `${DELIVERY_SELECT} WHERE d.delivery_id = $1 LIMIT 1`,
        [delivery.deliveryId],
      );
      await client.query("COMMIT");
      return updated.rows[0] as DeliveryLedgerRecord;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
  s.updated_at AS "updatedAt",
  sr.receipt_id AS "receiptId",
  sr.signed_token AS "receiptToken",
  d.delivery_id AS "deliveryId",
  d.status AS "deliveryStatus",
  d.response_digest AS "responseDigest"
FROM settlements s
JOIN quotes q ON q.quote_id = s.quote_id
LEFT JOIN settlement_receipts sr ON sr.settlement_id = s.settlement_id
LEFT JOIN deliveries d ON d.settlement_id = s.settlement_id`;

const RECONCILIATION_SELECT = `SELECT
  settlement.*,
  q.audience,
  q.request_method AS "requestMethod",
  q.canonical_url AS "canonicalUrl",
  q.body_hash AS "bodyHash",
  q.asset_id AS "assetId",
  q.amount_atomic::text AS "amountAtomic",
  q.pay_to AS "payTo"
FROM (${SETTLEMENT_SELECT}) settlement
JOIN settlements s ON s.settlement_id = settlement."settlementId"
JOIN quotes q ON q.quote_id = s.quote_id`;

const DELIVERY_SELECT = `SELECT
  d.delivery_id AS "deliveryId",
  d.settlement_id AS "settlementId",
  q.merchant_id AS "merchantId",
  d.status,
  d.attempt_count AS "attemptCount",
  d.response_digest AS "responseDigest",
  d.retry_expires_at AS "retryExpiresAt",
  sr.receipt_id AS "receiptId",
  sr.signed_token AS "receiptToken"
FROM deliveries d
JOIN settlements s ON s.settlement_id = d.settlement_id
JOIN quotes q ON q.quote_id = s.quote_id
JOIN settlement_receipts sr ON sr.settlement_id = s.settlement_id`;
