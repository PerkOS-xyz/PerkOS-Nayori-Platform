-- Preserve operator scope after primary metadata retention removes its source row.
-- Unresolvable historical intents remain NULL and require operator review, never blind purge.
ALTER TABLE private_evidence_backups ADD COLUMN IF NOT EXISTS contract text;
UPDATE private_evidence_backups AS b SET contract=o.contract
FROM private_evidence_objects AS o
WHERE b.evidence_id=o.id AND o.network='testnet' AND b.contract IS NULL;
CREATE INDEX IF NOT EXISTS private_evidence_backups_scope ON private_evidence_backups (contract,created_at);
