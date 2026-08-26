CREATE TABLE merchants (
  merchant_id varchar(64) PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  api_key_hash char(64) NOT NULL UNIQUE CHECK (api_key_hash ~ '^[0-9a-f]{64}$'),
  allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_origins) = 'array'),
  allowed_audiences jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_audiences) = 'array'),
  recipient_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(recipient_allowlist) = 'array'),
  route_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(route_config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  quote_id varchar(64) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL REFERENCES merchants(merchant_id) ON DELETE RESTRICT,
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 2048),
  request_method varchar(16) NOT NULL CHECK (request_method ~ '^[A-Z]+$'),
  canonical_url text NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 4096),
  body_hash char(64) NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  network text NOT NULL CHECK (length(network) BETWEEN 1 AND 128),
  asset_id text NOT NULL CHECK (length(asset_id) BETWEEN 1 AND 512),
  amount_atomic numeric(78, 0) NOT NULL CHECK (amount_atomic > 0),
  pay_to text NOT NULL CHECK (length(pay_to) BETWEEN 1 AND 256),
  fingerprint varchar(34) NOT NULL UNIQUE CHECK (fingerprint ~ '^ny1_[A-Za-z0-9_-]{27}$'),
  route_config_hash char(64) NOT NULL CHECK (route_config_hash ~ '^[0-9a-f]{64}$'),
  signed_token_hash char(64) NOT NULL UNIQUE CHECK (signed_token_hash ~ '^[0-9a-f]{64}$'),
  mechanism text NOT NULL CHECK (mechanism = 'stacks-signed-tx-v1'),
  status text NOT NULL CHECK (status IN ('issued', 'reserved', 'consumed', 'expired', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at)
);

CREATE INDEX quotes_merchant_status_idx ON quotes (merchant_id, status);
CREATE INDEX quotes_expiry_idx ON quotes (expires_at) WHERE status IN ('issued', 'reserved');

CREATE TABLE settlements (
  settlement_id varchar(64) PRIMARY KEY,
  quote_id varchar(64) NOT NULL UNIQUE REFERENCES quotes(quote_id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (length(network) BETWEEN 1 AND 128),
  txid varchar(66),
  payer text,
  raw_tx_hash char(64) CHECK (raw_tx_hash IS NULL OR raw_tx_hash ~ '^[0-9a-f]{64}$'),
  verifier_version varchar(64) NOT NULL,
  verifier_checksum char(64) NOT NULL CHECK (verifier_checksum ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN ('validated', 'broadcast', 'pending', 'confirmed', 'failed', 'dropped', 'reorged')
  ),
  failure_reason varchar(128),
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  confirmed_block_height numeric(20, 0),
  confirmed_block_hash varchar(66),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (txid IS NULL OR txid ~ '^0x[0-9a-f]{64}$'),
  CHECK (confirmed_block_height IS NULL OR confirmed_block_height >= 0),
  CHECK (
    status <> 'confirmed'
    OR (
      txid IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND confirmed_block_height IS NOT NULL
      AND confirmed_block_hash IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX settlements_network_txid_unique
  ON settlements (network, txid)
  WHERE txid IS NOT NULL;
CREATE INDEX settlements_status_updated_idx ON settlements (status, updated_at);

CREATE TABLE deliveries (
  delivery_id varchar(64) PRIMARY KEY,
  settlement_id varchar(64) NOT NULL UNIQUE
    REFERENCES settlements(settlement_id) ON DELETE RESTRICT,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (
    status IN ('delivery_pending', 'delivering', 'delivered', 'failed', 'expired')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  delivery_started_at timestamptz,
  delivery_completed_at timestamptz,
  response_digest char(64)
    CHECK (response_digest IS NULL OR response_digest ~ '^[0-9a-f]{64}$'),
  retry_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'delivered' OR delivery_completed_at IS NOT NULL)
);

CREATE INDEX deliveries_status_updated_idx ON deliveries (status, updated_at);

CREATE TABLE settlement_transitions (
  transition_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id varchar(64) NOT NULL REFERENCES settlements(settlement_id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  reason_code varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settlement_transitions_settlement_idx
  ON settlement_transitions (settlement_id, transition_id);

CREATE FUNCTION reject_settlement_transition_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'settlement_transitions is append-only';
END;
$$;

CREATE TRIGGER settlement_transitions_append_only
BEFORE UPDATE OR DELETE ON settlement_transitions
FOR EACH ROW EXECUTE FUNCTION reject_settlement_transition_mutation();
