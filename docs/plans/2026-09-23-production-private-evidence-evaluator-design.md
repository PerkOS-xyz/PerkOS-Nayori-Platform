# Production private-evidence evaluator integration

## Decision

Promote the already tested direct-S3 evidence boundary to Stacks mainnet without opening evaluator
admission to the public. Production uses a dedicated bucket, service credential, OAuth client and
wallet-linked `evidence:read` grant. QA and production remain separate exact tuples. A runtime that
mixes their network, issuer, canonical resource audience, API origin, Hiro origin, contracts,
bucket class or confirmation string
must fail before opening an HTTP port.

The existing QA switch remains backward compatible. A new environment-neutral switch selects an
explicit `qa` or `production` tuple. Production additionally requires a human-readable activation
confirmation. No ambient AWS credentials, wildcard contracts, generic OAuth issuer or configurable
arbitrary chain origin are accepted.

## Data flow and trust boundaries

The provider requests a short-lived upload capability from Platform using a wallet-bound OAuth
token with `evidence:write`, uploads directly to S3 and confirms the exact checksum, byte count and
object version. Platform stores metadata only. The Evaluator obtains a short-lived
`evidence:read` token from OAuth, asks Platform to authorize one evidence UUID against the current
mainnet job and receives an at-most-60-second S3 URL. OAuth is sent only to Platform and never to
S3, Hermes or PerkOS-LLM.

Platform revalidates issuer state, merchant state and the current Stacks role before returning a
capability. The Evaluator then checks the exact production S3 hostname, size, SHA-256, UTF-8 and
media type. The model receives verified content only. The Evaluator may sign only
`record-decision`; it cannot settle escrow, resolve an appeal or use the treasury.

## Failure behavior

Missing or stale OAuth identity, issuer saturation, a changed chain tip, deleted/expired metadata,
wrong object version, redirect, unexpected hostname, checksum mismatch or model disagreement all
fail closed. Tokens, signed URLs and evidence bytes never enter logs or public artifacts. An
ambiguous Stacks broadcast is quarantined and reconciled manually; it is never retried blindly.

Production starts with `PUBLIC_COMMITTED_EVALUATIONS=false`. Only the internal authenticated route
may enqueue the first controlled evaluation. Enabling private evidence does not imply public
admission and does not authorize a transaction by itself.

## Release and verification

First merge the current production tree into QA, run unit/integration tests with disposable
PostgreSQL and mocked S3, then deploy the exact QA commit. Prove OAuth issuance, current-client
revocation, upload/confirm/download, cross-job denial, expiration, restart durability and an
Evaluator read without leaking credentials. Promote the same reviewed tree to `main`, provision a
separate production bucket and least-privilege identity, back up databases, deploy from the Mac to
the VPS and repeat read-only probes.

The first mainnet canary must use a deliberately created job with explicit operator authorization.
Verify the `record-decision` transaction, DB record, public artifact, on-chain decision and absence
of settlement. Internal canary activity is operational evidence, not external M2 adoption.
