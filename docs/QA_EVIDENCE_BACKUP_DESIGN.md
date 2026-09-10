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
The S3 restore writer/readback and cross-system orphan reconciliation are still not implemented.

Before activation: integrate bounded pending-work enumeration, ledger purge/retention and
orphan reconciliation, separate least-privilege operator credentials, the S3 restore runner,
and scheduled execution with independent monitoring. Test missed schedules and expiration
during recovery. Complete OAuth/SDK/MCP/evaluator integration. No production changes here.
