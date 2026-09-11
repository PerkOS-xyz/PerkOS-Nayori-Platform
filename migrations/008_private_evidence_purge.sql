-- A tombstone preserves expiry and cleanup state during the backup grace period.
ALTER TABLE private_evidence_objects ADD COLUMN IF NOT EXISTS purged_at timestamptz;
