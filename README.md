# PerkOS Nayori Platform

Private API and reconciliation infrastructure for [Nayori](https://nayori.ai), the Bitcoin
Commerce Agent by PerkOS.

## Current status

This repository is at the **testnet verification and broadcast boundary**. It provides a
fail-closed HTTP service, merchant authentication, request-bound Ed25519-signed quotes, the pinned
SDK verifier, durable quote reservation and exactly one Stacks testnet broadcast attempt.

Verification and settlement remain disabled by default. Even when enabled, `broadcast` and
`pending` are explicitly unconfirmed: this release does **not** reconcile confirmations, deliver
paid resources, sponsor fees or settle on mainnet. Milestone 1 contracts and mainnet deployments
are reused unchanged.

## Architecture

```text
Agent / Leather
      |
      v
Resource server ---- merchant auth ----> api.nayori.ai
                                           |       |
                                      PostgreSQL  Stacks/Hiro
                                           |
                                    reconciliation worker
```

The API and future worker are separate runtime entrypoints within one TypeScript service. The
database is dedicated to Nayori and must not reuse another PerkOS product database.

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
| `POST /v1/quotes` | Authenticated request-bound quote issuance when enabled |
| `POST /v1/x402/verify` | Authenticated verify-only check; never broadcasts |
| `POST /v1/x402/settle` | Reserves and broadcasts once on testnet; returns unconfirmed state |
| `GET /v1/x402/settlements/:id` | Merchant-isolated status for a reserved settlement |

Quote and JWKS routes are absent while `QUOTE_ISSUANCE_ENABLED=false`. Verify is absent unless
`PAYMENT_VERIFICATION_ENABLED=true`; settle and status are absent unless
`SETTLEMENT_ENABLED=true`. No placeholder capability is advertised.

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

The command validates every route through SDK 0.2.0, writes only a SHA-256 credential digest and
prints the new `ny_mk_` API key once. Store that key in the merchant secret manager. Named route
configuration fixes method, path prefix, audience, network, asset, amount, recipient and TTL on
the server, so the quote request cannot redirect funds or change price.

## Persistence invariants

Migrations establish:

- unique quote fingerprints and signed-token hashes;
- one settlement per quote;
- unique `(network, txid)` replay protection;
- row-locked quote reservation before any external broadcast;
- positive exact atomic amounts;
- payment and delivery as separate states;
- append-only settlement transitions;
- migration checksums protected by a PostgreSQL advisory lock.
- versioned merchant route configuration, active-credential lookup and a five-minute database
  ceiling on quote lifetime.

The schema and quote issuer support STX, sBTC and USDCx profiles without enabling settlement.

## SDK boundary

Transaction parsing and economic verification belong in the public
[`@perkos/agent-sdk`](https://www.npmjs.com/package/@perkos/agent-sdk). The platform pins exact
release `0.2.0`; it does not copy the SDK implementation.

SDK 0.2.0 owns quote canonicalization, asset definitions, x402 requirements, fingerprints, origin
signature validation and the pure `stacks-signed-tx-v1` verifier. This Platform release invokes
that verifier, rejects sponsorship, compares the signed token to its issued database record and
persists only normalized evidence and a raw-transaction digest before broadcasting.

## Planned PR sequence

1. Foundation: truthful discovery, PostgreSQL, migration runner, Docker and CI — complete.
2. Merchant authentication and signed, short-lived request quotes — complete.
3. Pinned SDK verifier, durable reservation and testnet broadcast — this release.
4. Reconciliation worker, confirmation receipts and delivery ledger.
5. Leather/headless examples and external clean-room quickstart.
6. Isolated sponsor relay only after the non-sponsored path passes review.

See [`docs/plans/2026-08-26-facilitator-foundation-design.md`](docs/plans/2026-08-26-facilitator-foundation-design.md)
[`docs/plans/2026-08-26-merchant-auth-signed-quotes-design.md`](docs/plans/2026-08-26-merchant-auth-signed-quotes-design.md)
and [`docs/plans/2026-08-27-testnet-settlement-design.md`](docs/plans/2026-08-27-testnet-settlement-design.md)
for the approved designs and security boundaries.

## Milestone 2 alignment

This platform helps produce a stronger SDK demo and external pilot, but it does not replace the M2
external security review, ten mainnet agents, five completed sBTC jobs, non-team wallets or
external developer feedback. M1 is approved and remains unchanged.
