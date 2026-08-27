ALTER TABLE settlements
  ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_lease_until timestamptz,
  ADD COLUMN reconcile_attempt_count integer NOT NULL DEFAULT 0
    CHECK (reconcile_attempt_count >= 0),
  ADD COLUMN last_checked_at timestamptz;

CREATE INDEX settlements_reconcile_ready_idx
  ON settlements (reconcile_after, created_at)
  WHERE status IN ('validated', 'broadcast', 'pending');

CREATE TABLE settlement_receipts (
  receipt_id varchar(64) PRIMARY KEY CHECK (receipt_id ~ '^nr_[0-9a-f]{32}$'),
  settlement_id varchar(64) NOT NULL UNIQUE
    REFERENCES settlements(settlement_id) ON DELETE RESTRICT,
  key_id varchar(128) NOT NULL,
  payload_hash char(64) NOT NULL UNIQUE CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  signed_token text NOT NULL CHECK (length(signed_token) BETWEEN 1 AND 16384),
  issued_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settlement_receipts_settlement_idx
  ON settlement_receipts (settlement_id);

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_deterministic_id
  CHECK (delivery_id ~ '^nd_[0-9a-f]{32}$') NOT VALID;

ALTER TABLE deliveries VALIDATE CONSTRAINT deliveries_deterministic_id;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_reconciliation_lease
  CHECK (
    reconcile_lease_until IS NULL
    OR status IN ('validated', 'broadcast', 'pending')
  ) NOT VALID;

ALTER TABLE settlements VALIDATE CONSTRAINT settlements_reconciliation_lease;
