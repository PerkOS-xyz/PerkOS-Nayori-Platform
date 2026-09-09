-- Metadata only. No file bytes, signed URLs, credentials or encryption keys.
CREATE TABLE IF NOT EXISTS private_evidence_objects (
  id uuid PRIMARY KEY,
  network text NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  contract text NOT NULL,
  job_id text NOT NULL,
  provider text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text NOT NULL CHECK (media_type IN ('text/plain', 'application/json')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 8192),
  object_key text NOT NULL UNIQUE,
  upload_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  version_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > upload_expires_at),
  CHECK (version_id IS NULL OR (version_id <> '' AND version_id <> 'null'))
);
CREATE INDEX IF NOT EXISTS private_evidence_objects_job ON private_evidence_objects (network, contract, job_id);
CREATE INDEX IF NOT EXISTS private_evidence_objects_expiry ON private_evidence_objects (expires_at);
