-- Operator ledger only: metadata, never bytes/credentials/signed URLs. No cascade from source
-- cleanup: a pending backup must remain discoverable until S3 absence has been verified.
CREATE TABLE IF NOT EXISTS private_evidence_backups (
  evidence_id uuid PRIMARY KEY,
  expected jsonb NOT NULL,
  manifest jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified','purged')),
  restored_version text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (state <> 'verified' OR manifest IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS private_evidence_backups_pending ON private_evidence_backups (state, created_at);
