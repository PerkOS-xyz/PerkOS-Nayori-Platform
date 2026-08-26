# Nayori facilitator foundation design

Date: 2026-08-26  
Status: approved for implementation  
Milestone: M2 — Agent SDK + Security Review + First Adoption

## Goal and boundaries

Build the private operational foundation for `api.nayori.ai` without reopening Milestone 1 or
changing the deployed STX and sBTC contracts. The service will eventually issue request-bound
quotes, verify signed Stacks transactions, settle them exactly once and reconcile chain state.
This first increment intentionally exposes only truthful, read-only service metadata and database
readiness. It must not broadcast a transaction, claim settlement availability, deliver a paid
resource, sponsor fees or custody a buyer key.

The foundation is testnet-first and fail-closed. `SETTLEMENT_ENABLED` and `SPONSORSHIP_ENABLED`
must remain false. Mainnet settlement requires later implementation, external review and an
explicit release decision. M2 remains governed by `StacksEndowment/Milestones.md`; this service
supports the SDK demo and external adoption but does not replace the required security review,
mainnet sBTC jobs or non-team wallets.

## Chosen structure

Use one Node.js 22 TypeScript package with separate future API and worker entrypoints and shared
domain modules. Hono provides the HTTP surface; PostgreSQL 16 stores merchants, quotes,
settlements and deliveries. This is smaller than a workspace containing independent API, worker
and shared packages, while still allowing the two processes to run in separate containers. A
future split can happen when release cadence or scaling requires it.

Alternatives rejected for this stage:

- A multi-package monorepo adds build, versioning and dependency boundaries before there are two
  independently useful applications.
- Next.js route handlers would couple payment settlement to the public web release and enlarge the
  blast radius of a frontend deployment.
- Forking the reviewed public Go facilitator would inherit unsafe verification and settlement
  behavior already documented in the internal threat analysis.

## HTTP surface

The foundation exposes:

- `GET /health` — process liveness only;
- `GET /ready` — PostgreSQL connectivity, returning 503 when unavailable;
- `GET /supported` — accurate foundation status with settlement and sponsorship disabled;
- `GET /x402.json` — machine-readable mechanism availability;
- `GET /.well-known/agent.json` — API identity and discovery links;
- `GET /llms.txt` — concise agent-readable guidance;
- `GET /openapi.json` — the routes that actually exist in this release.

There are no placeholder `/verify` or `/settle` handlers. Returning a successful-looking stub
would encourage integration against behavior that has not met the security gates. Unknown routes
return a typed JSON 404. Each response receives a bounded request ID and security headers. Logs
include method, path, status, duration and request ID, but never authorization headers or bodies.

## Configuration and data

Startup configuration is schema-validated. The service requires `DATABASE_URL`; network defaults
to Stacks testnet. Production refuses truthy settlement or sponsorship flags in this foundation.
Database connections use a bounded pool, connection timeout, query timeout and application name.

The first migration defines:

- merchants with hashed credentials and allowlisted route configuration;
- short-lived quotes bound to method, URL, body hash, network, asset, amount and recipient;
- settlements with unique quote and `(network, txid)` replay constraints;
- deliveries tracked separately from payment confirmation;
- an append-only transition log for auditable state changes.

Atomic amounts use high-precision numeric storage with positive-value checks. State columns use
explicit check constraints. The migration runner takes a PostgreSQL advisory lock, records SHA-256
checksums and rejects an already-applied migration whose contents changed.

## SDK boundary

The hosted verifier must reuse `@perkos/agent-sdk`; it must not copy its transaction decoder or
economic checks. The only published npm release is currently `0.1.0`, while the direct
`stacks-signed-tx-v1` verifier is merged but not yet released. Therefore this foundation does not
add an unused or incomplete SDK dependency. The settlement PR must first pin a new SDK release
containing the direct verifier, then inject it behind a narrow adapter.

## Deployment and verification

The repository includes a non-root multi-stage Docker image and a development Compose file with a
dedicated PostgreSQL 16 volume. Neither API nor database configuration contains production
secrets. The VPS deployment and real environment remain outside GitHub.

CI on Node.js 22 runs formatting-independent lint rules, strict type checking, unit tests, build
and dependency audit. Tests cover liveness, readiness success/failure, discovery truthfulness,
security headers, request IDs, 404/error responses, fail-closed flags and migration invariants.
The next PR will implement merchant authentication and signed quote issuance; settlement remains
separate so its verifier, replay and timeout behavior can receive focused review.
