# Chain snapshot backpressure release fix

## Decision

When two consecutive authorization reads each cross a Stacks tip boundary, the
adapter has no single fresh snapshot it can safely use. Surface only this exact
condition as HTTP503 with `Retry-After: 1` and the existing generic temporary
unavailability body. Keep malformed responses, wrong network, stale nodes,
timeouts, invalid credentials and unauthorized roles fail-closed as403.

The API does not accept earlier snapshot data, add a third server-side read,
sleep, cache authorization or replay `prepare`. The caller may retry after one
second; authentication, current revocation, job state, escrow and roles are
evaluated again from scratch. `complete` and `download` reuse their evidence ID.
`prepare` remains non-idempotent and should be reconciled before a caller repeats
it after any ambiguous response.

## Release gate

Unit and PostgreSQL integration CI must pass. After QA deployment, verify an
actual double-tip response as503 rather than403, authorized consumer/provider
recovery, unauthorized403, and the existing job17 evidence hash. Then execute
one canonical SDK/MCP-to-evaluator settlement in QA. No further hardening blocks
the release candidate unless it can lose funds, expose private evidence, bypass
authorization or prevent the core workflow.
