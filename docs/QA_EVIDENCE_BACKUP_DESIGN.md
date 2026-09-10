# QA private evidence backup gates

Status: policy, S3 adapter and operator ledger implemented; private uploads remain disabled.

Use an independent private bucket, not a second version in the primary bucket. Application
and primary cleanup identities must have no access to the backup. Separate-bucket isolation
does not protect against compromise of the entire AWS account. Native replication alone does
not enforce per-record absolute expiration or restore the SQL version mapping.

## Approved direction

1. A bounded operator copies only finalized, unexpired testnet records, pinned to exact source
   versions. Verify bytes and persist a manifest with immutable original expiration.
2. Access ends at original expiration. Backup retention ends at that expiration plus seven days,
   not seven days after a copy, retry or recovery. Purge all exact versions and verify absence.
3. Restore requires verified bytes and trusted SQL metadata under a row lock. Write a new source
   version, verify it, recheck expiration and compare-and-swap the SQL version mapping. Handle
   failed commits and orphan versions explicitly; never resurrect a tombstoned record.

The pure policy module rejects unsafe paths, networks, versions, changed expiry, altered bytes,
and manifests inconsistent with trusted metadata. It distinguishes restorable, retained-only
and purge-due phases. It performs no AWS or SQL operations and is not exposed over HTTP/MCP.

## Evidence and remaining work

A synthetic QA AWS experiment recovered an object after permanently deleting its original
version; 10 checks passed and fixture versions were removed. This is not a transactional SQL
restore or a whole-bucket disaster recovery exercise.

The operator-only S3 adapter now copies exact source versions, limits reads to 8192 bytes,
uses conditional creation and verifies existing copies on retries without extending retention.
Purge validates all enumerated versions before deleting any, rejects truncated inventories and
delete markers, and verifies absence afterward. Ambiguous writes require a later reconciliation
attempt; they are not retried blindly. No routes or scheduler register this adapter.

Six real S3 QA fixture checks passed: verified copy, identical retry, a single backup version,
early purge rejection, due purge and empty retry. Deadline advancement used an injected clock
only for synthetic data; this does not prove wall-clock retention enforcement. Fixtures were
removed. The experiment used temporary operator access on the Mac, not deployed backup keys.

Migration 009 adds a metadata-only operator ledger. Reserve commits a pending snapshot before
copying; verification binds the manifest and bytes to the locked source row. The ledger survives
source deletion, so cleanup cannot silently discard an unresolved backup. No payloads are stored.

`commitRestore` is the SQL half of recovery: after a caller writes and reads back the exact new
S3 version, it atomically changes the source mapping and records that version. Same-version retry
is idempotent; competing restores, tombstones and expiration are rejected. An ambiguous SQL
commit must be reconciled by retrying the SAME version, never by deleting it blindly.
The S3 restore adapter now requires explicit restore credentials. It reads the exact backup
version, verifies it against the ledger snapshot, and conditionally writes only to an absent
primary key. Metadata tags bind the restored version to its backup/source version and expiry.
A retry recognizes and reads back that same version instead of duplicating it; an untagged or
conflicting existing primary is never overwritten. The operator orchestrator loads the ledger,
performs verified S3 restore, then commits the SQL mapping. It never deletes a version in response
to an ambiguous SQL failure. This handles interrupted restores while the evidence is unexpired;
expired/orphaned cases still require reconciliation and scheduled cleanup.

Restore identity needs primary Get/GetVersion, conditional Put and scoped ListBucket for absence
detection. The application identity must not be broadened: S3 can return 403, not 404, for an absent
key when list permission is missing. A real QA fixture with normal service permissions failed
closed; temporary operator credentials then passed six restore/retry/expiry checks. Both runs
cleaned their fixtures. No new identity was deployed and no production settings changed.

On 2026-09-10, the merged implementation also passed an 11-check combined real S3 + PostgreSQL
QA exercise. PostgreSQL ran in an isolated disposable container, reached through an SSH tunnel;
AWS credentials remained on the operator workstation. The test persisted intent, copied and
verified the backup, refused to overwrite the existing primary, then permanently removed only
the synthetic original version. It restored bytes and committed the SQL mapping/receipt while
preserving expiration. Losing the response after a real SQL commit was injected; retry reused
the same S3 version with no duplicate. The final bytes matched and an expired SQL row was denied.

Both synthetic S3 keys were purged and verified absent; the disposable database, network and
tunnel were removed. This proves the exercised operator recovery path, not whole-account loss,
database-loss recovery, missed schedules or a deployed autonomous backup service.

Migration 010 preserves the source contract on each backup intent. Historical entries whose
source is already missing cannot be safely scoped and remain quarantined (NULL contract) for
operator review. They are never purged just because they are old.

The operator retention module processes at most ten due intents, dry-run by default, with row
locks and explicit testnet contract scope. It includes expired pending intents: a PUT might have
succeeded before SQL verification. Their original snapshot determines the exact backup key and
deadline. The S3 adapter validates all versions and absence before SQL removes an intent. Failure
rolls SQL back, retaining the intent for retry; a prior partial S3 deletion can safely resume with
an empty inventory. A conflicting manifest stops cleanup. This does not restore expired access.

Unexpired reconciliation is now an operator-only module: at most ten sequential candidates,
dry-run by default, with a PostgreSQL session advisory lock preventing overlapping batches in
the same schema. It selects finalized, unexpired, non-purged sources in the configured testnet
contracts, excluding already-verified work. Reserve commits before copy; exact-version backup
readback precedes SQL verification. Failed copies remain pending, and their attempt timestamp
is moved back in the queue without changing expiration. Counts contain no payloads or raw errors.
The scheduler must treat a nonzero `failed` count as actionable, not as a healthy run.

The operator pool must allow at least two connections: one holds the batch lock and another
performs short ledger transactions. Connections with uncertain advisory lock state are discarded.
Expired source rows are left for retention, and quarantined entries still need operator review.

Before activation: operator handling of quarantined/corrupt records, separate least-privilege operator credentials,
and scheduled execution with independent monitoring. Test missed schedules and expiration
during recovery. Complete OAuth/SDK/MCP/evaluator integration. No production changes here.

The [one-shot QA operator](QA_BACKUP_OPERATOR.md) now exposes status/reconcile/retire with
explicit confirmation, bounded diagnostics and nonzero attention/failure outcomes. It is not
deployed or scheduled; IAM provisioning and live operator tests remain activation gates.
