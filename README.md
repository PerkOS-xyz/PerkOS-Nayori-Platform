# PerkOS Nayori Platform

Private API and reconciliation infrastructure for [Nayori](https://nayori.ai), the Bitcoin
Commerce Agent by PerkOS.

## Current status

This repository is at the **same-origin paid-resource, external-OAuth and testnet settlement boundary**. It
validates wallet-linked OAuth tokens issued by `oauth.nayori.ai`, retains backward-compatible
merchant API keys, and provides a scoped MCP endpoint, request-bound quotes, the pinned SDK
verifier, durable reservation, one Stacks testnet
broadcast attempt, leased reconciliation, canonical confirmation-depth checks and signed
settlement receipts. A resource-server runtime can now expose the real x402 v2 payment flow at
`api.nayori.ai/v1`, while a separately configured runtime owns settlement at
`facilitator.nayori.ai`.

All write capabilities remain disabled by default. `broadcast` and `pending` are unconfirmed and
cannot create a receipt or delivery record. Once confirmed, the merchant resource server uses a
stable delivery ID to deduplicate resource delivery; Nayori does not proxy arbitrary merchant
URLs. Mainnet and sponsorship remain disabled. M1 contracts and deployments are unchanged.

## Architecture

```text
Agent / Leather ---> nayori.ai/api/v1 (same-origin proxy)
                              |
                              v
                    api.nayori.ai/v1 (paid resource)
                              |
                    merchant-authenticated HTTPS
                              v
                  facilitator.nayori.ai (quote / verify / settle)
                              |                 |
                         PostgreSQL        Stacks/Hiro testnet
                              |
                      reconciliation worker

Agent / framework ---> oauth.nayori.ai (issuer / JWKS) ---> api.nayori.ai (MCP / partner API)
```

The resource server, facilitator and reconciliation worker are isolated runtime roles built from
one TypeScript service. The resource server holds only its facilitator merchant credential; quote
signing, settlement state and the delivery ledger remain on the facilitator. The database is
dedicated to Nayori and must not reuse another PerkOS product database. OAuth
client state and signing material belong to the separate private `PerkOS-Nayori-OAuth` service.

## Implemented endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Process liveness; does not touch PostgreSQL |
| `GET /ready` | PostgreSQL readiness; returns 503 when unavailable |
| `GET /supported` | Truthful capability and release-boundary status |
| `GET /x402.json` | Machine-readable x402 foundation metadata |
| `GET /.well-known/agent.json` | Agent discovery manifest |
| `GET /.well-known/jwks.json` | Public Ed25519 quote-verification keys when issuance is enabled |
| `GET /llms.txt` | Agent-readable usage and safety guidance |
| `GET /openapi.json` | OpenAPI document containing only implemented routes |
| `GET /.well-known/oauth-authorization-server` | Redirect to the external RFC 8414 issuer in external mode |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 metadata for canonical resource `nayori.ai` |
| `GET /oauth/jwks.json` | Redirect to the external issuer JWKS in external mode |
| `GET /auth.md` | Agent-readable authentication and wallet-signing boundary |
| `POST /oauth/token` | Embedded rollback mode only; external clients call `oauth.nayori.ai` directly |
| `POST /v1/partners/challenges` | External OAuth service only; unavailable on Platform in external mode |
| `POST /v1/partners/register` | External OAuth service only; unavailable on Platform in external mode |
| `GET /.well-known/mcp/server-card.json` | Experimental MCP server card |
| `POST /mcp` | Authenticated Streamable HTTP JSON-RPC with implemented Nayori tools |
| `GET /v1` | Public x402 v2 challenge, payment submission, asynchronous polling and confirmed capability-report delivery |
| `POST /v1/quotes` | Authenticated request-bound quote issuance when enabled |
| `POST /v1/x402/verify` | Authenticated verify-only check; never broadcasts |
| `POST /v1/x402/settle` | Reserves and broadcasts once on testnet; returns unconfirmed state |
| `GET /v1/x402/settlements/:id` | Merchant-isolated status for a reserved settlement |
| `POST /v1/x402/settlements/:id/delivery/claim` | Claims the stable delivery ID and signed receipt |
| `POST /v1/x402/settlements/:id/delivery/complete` | Records an idempotent response digest |

The public `GET /v1` route is absent while `PUBLIC_RESOURCE_ENABLED=false`. Its 402 challenge uses
`PAYMENT-REQUIRED`; payment submission uses `PAYMENT-SIGNATURE` plus the explicitly advertised
`X-NAYORI-SIGNED-QUOTE` extension. A submitted Stacks transaction returns 202 and a polling URL
until canonical confirmation. Only a confirmed settlement returns the resource with
`PAYMENT-RESPONSE`.

Quote and JWKS routes are absent while `QUOTE_ISSUANCE_ENABLED=false`. Verify is absent unless
`PAYMENT_VERIFICATION_ENABLED=true`; settle and status are absent unless
`SETTLEMENT_ENABLED=true`; delivery routes are absent unless `DELIVERY_LEDGER_ENABLED=true`. No
placeholder capability is advertised.

OAuth and MCP are independently fail-closed. In external mode Platform fetches only public JWKS,
validates EdDSA, issuer, audience, lifetime and scopes, then requires its own merchant to remain
active. OAuth authorizes API access; it cannot sign a payment. Every STX, sBTC or USDCx transfer
remains a separate wallet-approved transaction.

## Requirements

- Node.js 22+
- PostgreSQL 16+
- npm

## Local development

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

With all required feature flags and signing material configured, run reconciliation as a separate
process:

```bash
npm run reconcile
```

Run the complete verification suite:

```bash
npm run verify
npm audit --audit-level=high
```

The example Compose stack starts a dedicated local database and API:

```bash
docker compose -f compose.example.yaml up --build
```

Production images are built on the PerkOS VPS from an exact merged commit. Production secrets and
operational Compose/Caddy files remain outside GitHub.

## Configuration

See [`.env.example`](.env.example). Important fail-closed settings:

- `STACKS_NETWORK=testnet` is the default.
- `QUOTE_ISSUANCE_ENABLED=false` is the default and requires a valid private Ed25519 JWK when
  enabled.
- `QUOTE_MAX_TTL_SECONDS` cannot exceed five minutes.
- `QUOTE_PREVIOUS_PUBLIC_JWKS_JSON` retains public keys briefly during rotation; private members
  are rejected.
- `PAYMENT_VERIFICATION_ENABLED=true` requires quote issuance.
- `SETTLEMENT_ENABLED=true` requires verification and is rejected unless the configured Stacks
  network is testnet.
- `STACKS_API_URL` selects the testnet broadcast origin; production mode requires HTTPS.
- `STACKS_BROADCAST_TIMEOUT_MS` bounds the only broadcast attempt. Timeouts become `pending` and
  are never blindly retried.
- `PAYMENT_RATE_LIMIT_PER_MINUTE` bounds authenticated verify, settle and status operations per
  merchant in each process; edge limits remain required for distributed abuse protection.
- `RECONCILIATION_ENABLED=true` requires testnet settlement. The worker claims bounded batches
  with PostgreSQL leases and never broadcasts.
- `SETTLEMENT_MIN_CONFIRMATIONS` controls canonical depth before a signed receipt can exist.
- `RECONCILIATION_BATCH_SIZE`, `RECONCILIATION_INTERVAL_MS` and `RECONCILIATION_LEASE_MS` bound
  worker load and crash recovery.
- `DELIVERY_LEDGER_ENABLED=true` requires reconciliation. `DELIVERY_RETRY_TTL_SECONDS` limits how
  long an unclaimed confirmed delivery remains claimable.
- `OAUTH_ENABLED=true` plus `OAUTH_MODE=external` validates tokens from
  `OAUTH_ISSUER_ORIGIN` against `OAUTH_RESOURCE_ORIGIN` with `OAUTH_JWKS_URI`; Platform does not
  receive the issuer private key.
- `OAUTH_MODE=embedded` remains a rollback option and requires a dedicated Ed25519 private JWK.
- `PARTNER_REGISTRATION_ENABLED` must remain false in external mode because enrollment is owned by
  `PerkOS-Nayori-OAuth`.
- `MCP_ENABLED=true` requires OAuth. The endpoint checks `mcp:invoke`, while quote and settlement
  tools also enforce their own downstream scopes and merchant isolation.
- `PUBLIC_RESOURCE_ENABLED=true` enables the resource-server role and requires
  `FACILITATOR_MERCHANT_API_KEY`. `PUBLIC_RESOURCE_URL`, `PUBLIC_RESOURCE_ROUTE_ID` and
  `FACILITATOR_ORIGIN` bind the public route to a separately hosted facilitator. The resource,
  API and facilitator origins must remain distinct; production origins require HTTPS.
- `FACILITATOR_REQUEST_TIMEOUT_MS` bounds every server-to-server facilitator call. The merchant
  credential is never returned to the payer, browser or same-origin proxy.
- `SPONSORSHIP_ENABLED` accepts only `false` or `0` in this release.
- `DATABASE_URL` must use `postgres://` or `postgresql://`.
- `SERVICE_ORIGIN` controls canonical discovery URLs.

The application validates configuration and signing material before it opens a listener.

## Merchant provisioning

Generate signing material outside GitHub:

```bash
npm run quote:keygen
```

Store the private JWK only in the VPS secret configuration. Publish verification keys through the
service JWKS endpoint; never commit generated key output.

Provision or rotate a merchant by setting `MERCHANT_ID`, the four JSON configuration variables
documented in the design, and `DATABASE_URL`, then run:

```bash
npm run merchant:provision
```

The command validates every route through SDK 0.3.2, writes only a SHA-256 credential digest and
prints the new `ny_mk_` API key once. Store that key in the merchant secret manager. Named route
configuration fixes method, path prefix, audience, network, asset, amount, recipient and TTL on
the server, so the quote request cannot redirect funds or change price.

## Invite-only partner OAuth pilot

The active issuer, client-credential database, signing-key rotation and invitation commands live in
the private [`PerkOS-Nayori-OAuth`](https://github.com/PerkOS-xyz/PerkOS-Nayori-OAuth) repository.
Platform stores neither the external OAuth private JWK nor external client secrets. The former
embedded implementation remains available only for rollback while migration is verified.

For embedded rollback mode only, generate a distinct OAuth signing key outside GitHub:

```bash
npm run oauth:keygen
```

In embedded rollback mode, after migrations and merchant provisioning, create a single-use invitation by setting
`PARTNER_MERCHANT_ID`, `PARTNER_SCOPES`, `PARTNER_INVITATION_TTL_SECONDS` and the normal database
configuration, then run:

```bash
npm run partner:invite
```

The invitation token is printed once and must travel through a private channel. The partner asks
for a challenge, signs the exact returned plaintext in Leather, and submits the signature plus
public key. Nayori derives the configured-network Stacks address, requires an exact match to the
invited wallet and atomically consumes both records. The returned client secret is stored only as
a SHA-256 digest and is never returned again.

Tokens use `client_credentials` with `client_secret_basic`. Supported scopes are
`catalog:read`, `quotes:create`, `payments:verify`, `payments:settle`, `payments:read` and
`mcp:invoke`.

## Persistence invariants

Migrations establish:

- unique quote fingerprints and signed-token hashes;
- one settlement per quote;
- unique `(network, txid)` replay protection;
- row-locked quote reservation before any external broadcast;
- positive exact atomic amounts;
- payment and delivery as separate states;
- leased reconciliation with `FOR UPDATE SKIP LOCKED`;
- one signed receipt and one deterministic delivery ID per confirmed settlement;
- idempotent completion by lowercase response SHA-256;
- append-only settlement transitions;
- migration checksums protected by a PostgreSQL advisory lock;
- versioned merchant route configuration, active-credential lookup and a five-minute database
  ceiling on quote lifetime.
- single-use partner invitation and wallet challenge consumption;
- wallet-linked, merchant-isolated OAuth clients with digested secrets and explicit scopes.

The schema and quote issuer support STX, sBTC and USDCx profiles without enabling settlement.

## SDK boundary

Transaction parsing and economic verification belong in the public
[`@perkos/agent-sdk`](https://www.npmjs.com/package/@perkos/agent-sdk). The platform pins exact
release `0.3.2`; it does not copy the SDK implementation.

SDK 0.3.2 owns quote canonicalization, asset definitions, x402 requirements, fingerprints, origin
signature validation and the pure `stacks-signed-tx-v1` verifier. This Platform release invokes
that verifier, rejects sponsorship, compares the signed token to its issued database record and
persists only normalized evidence and a raw-transaction digest before broadcasting.

## Known testnet limitations

- An ambiguous initial broadcast stays pending for observation; the platform intentionally does not
  rebroadcast transaction bytes and does not persist those bytes for a later automatic retry.
- A signed receipt is final after the configured canonical depth. This release does not continue
  sampling confirmed settlements or automatically revoke a receipt after a later deep reorganization.
  Operators must select a confirmation depth appropriate to the asset and environment.
- The delivery ledger makes retries idempotent by delivery ID, but the merchant resource server must
  enforce that key around its own external side effects.
- Mainnet and transaction sponsorship remain unavailable. The only automatic delivery is the
  fixed Nayori capability report after confirmed testnet settlement; arbitrary URL proxying remains
  unavailable.
- MCP Server Cards remain an experimental ecosystem extension; the card truthfully advertises
  only the implemented Streamable HTTP tools.

## Planned PR sequence

1. Foundation: truthful discovery, PostgreSQL, migration runner, Docker and CI — complete.
2. Merchant authentication and signed, short-lived request quotes — complete.
3. Pinned SDK verifier, durable reservation and testnet broadcast — complete.
4. Reconciliation worker, confirmation receipts and delivery ledger — complete.
5. SDK 0.3 paying flow and Platform verifier pin — complete; external clean-room remains a
   separate adoption gate.
6. Invite-only wallet-linked OAuth and scoped MCP partner pilot — complete.
7. Separate authorization server and external JWT/JWKS resource verification — complete.
8. Same-origin public x402 resource with an isolated facilitator and confirmation-gated delivery — this release.
9. Isolated sponsor relay only after the non-sponsored path passes review.

See [`docs/plans/2026-08-26-facilitator-foundation-design.md`](docs/plans/2026-08-26-facilitator-foundation-design.md)
[`docs/plans/2026-08-26-merchant-auth-signed-quotes-design.md`](docs/plans/2026-08-26-merchant-auth-signed-quotes-design.md)
and [`docs/plans/2026-08-27-testnet-settlement-design.md`](docs/plans/2026-08-27-testnet-settlement-design.md)
and [`docs/plans/2026-08-27-reconciliation-receipts-delivery-design.md`](docs/plans/2026-08-27-reconciliation-receipts-delivery-design.md)
and [`docs/plans/2026-08-27-sdk-0.3-isolated-e2e-gate-design.md`](docs/plans/2026-08-27-sdk-0.3-isolated-e2e-gate-design.md)
and [`docs/plans/2026-08-27-partner-pilot-oauth-mcp-design.md`](docs/plans/2026-08-27-partner-pilot-oauth-mcp-design.md)
and [`docs/plans/2026-08-27-external-oauth-resource-server-design.md`](docs/plans/2026-08-27-external-oauth-resource-server-design.md)
for the approved designs and security boundaries.

## Milestone 2 alignment

This platform helps produce a stronger SDK demo and external pilot, but it does not replace the M2
external security review, ten mainnet agents, five completed sBTC jobs, non-team wallets or
external developer feedback. M1 is approved and remains unchanged.
