# QA private evidence backup gates

Status: policy foundation only; private uploads remain disabled.

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

Before activation: implement and test bounded copy/purge adapters, durable idempotency and
orphan reconciliation, separate least-privilege operator credentials, SQL restore transactions,
and scheduled execution with independent monitoring. Test missed schedules and expiration
during recovery. Complete OAuth/SDK/MCP/evaluator integration. No production changes here.
