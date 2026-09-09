-- Inactive storage foundation. No public routes or operational encryption keys.
CREATE TABLE private_evidence (
  network text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  contract text NOT NULL,
  job_id numeric(39,0) NOT NULL CHECK (job_id > 0 AND job_id < 340282366920938463463374607431768211456),
  provider text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'application/json')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8192),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  stored_bytes integer NOT NULL CHECK (stored_bytes BETWEEN 1 AND 12000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (network, contract, job_id, provider, sha256)
);
CREATE INDEX private_evidence_expiry ON private_evidence (expires_at);
