# Bounded retry for private-evidence chain snapshots

## Problem and decision

A new Stacks block during the final freshness check can reject an otherwise valid
private-evidence request. Keep fail-closed authorization; do not accept stale
snapshots or cache permission decisions. Retry exactly once only when the final
node response is valid, synchronized, on the configured network, and has a
different valid tip. Discard all data from the first attempt.

Alternatives: client-only retries leave avoidable intermittent denials; accepting
the previous tip weakens freshness. A bounded fresh read preserves existing
security checks while accommodating ordinary block progression.

## Boundaries

Both attempts share the existing five-second deadline and AbortController. Each
attempt rechecks network, canonical block, freshness, allowlisted contract,
pinned job/escrow reads and final tip. No retries for authentication, ownership,
malformed responses, upstream errors, stale blocks or timeouts. A second tip
change still fails closed. No new broadcast, configuration or storage behavior.

## Verification and rollout

Test stable reads, changed job/provider in a fresh snapshot, repeated movement,
invalid final node metadata and deadline exhaustion across attempts. Existing
authorization tests must remain green. Deploy only after QA PR review/merge;
repeat real private HTTPS tests with existing synthetic evidence. No production
promotion or claims of full workflow completion from unit tests alone.
