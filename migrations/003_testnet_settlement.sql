ALTER TABLE settlements
  ADD COLUMN broadcast_attempted_at timestamptz;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_verified_material
  CHECK (
    txid IS NOT NULL
    AND payer IS NOT NULL
    AND length(payer) BETWEEN 1 AND 256
    AND raw_tx_hash IS NOT NULL
  ) NOT VALID;

ALTER TABLE settlements VALIDATE CONSTRAINT settlements_verified_material;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_broadcast_timestamps
  CHECK (
    (status = 'validated' AND broadcast_attempted_at IS NULL)
    OR (status <> 'validated' AND broadcast_attempted_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE settlements VALIDATE CONSTRAINT settlements_broadcast_timestamps;

CREATE INDEX settlements_merchant_lookup_idx ON settlements (settlement_id, quote_id);
