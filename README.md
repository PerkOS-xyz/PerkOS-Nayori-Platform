# PerkOS Nayori Platform

Private API and reconciliation infrastructure for [Nayori](https://nayori.ai), the Bitcoin
Commerce Agent by PerkOS.

## Current status

This repository is at **facilitator foundation** stage. It provides a fail-closed HTTP service,
PostgreSQL schema, migration runner, container build and CI. It does **not** yet issue payment
quotes, verify or broadcast transactions, settle payments, sponsor fees or deliver paid resources.

Those operations remain disabled until their SDK dependency, replay rules, timeout behavior,
external review and testnet evidence satisfy the release gates. Milestone 1 contracts and mainnet
deployments are reused unchanged.

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

## Foundation endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Process liveness; does not touch PostgreSQL |
| `GET /ready` | PostgreSQL readiness; returns 503 when unavailable |
| `GET /supported` | Truthful capability status; settlement and sponsorship are false |
| `GET /x402.json` | Machine-readable x402 foundation metadata |
| `GET /.well-known/agent.json` | Agent discovery manifest |
| `GET /llms.txt` | Agent-readable usage and safety guidance |
| `GET /openapi.json` | OpenAPI document containing only implemented routes |

No placeholder `/verify` or `/settle` endpoint exists. An unknown payment route returns 404.

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
- `SETTLEMENT_ENABLED` accepts only `false` or `0` in this release.
- `SPONSORSHIP_ENABLED` accepts only `false` or `0` in this release.
- `DATABASE_URL` must use `postgres://` or `postgresql://`.
- `SERVICE_ORIGIN` controls canonical discovery URLs.

The application validates configuration before it opens a listener.

## Persistence invariants

Migration `001_facilitator_foundation.sql` establishes:

- unique quote fingerprints and signed-token hashes;
- one settlement per quote;
- unique `(network, txid)` replay protection;
- positive exact atomic amounts;
- payment and delivery as separate states;
- append-only settlement transitions;
- migration checksums protected by a PostgreSQL advisory lock.

The schema supports STX, sBTC and USDCx profiles without making any asset live by configuration
alone.

## SDK boundary

Transaction parsing and economic verification belong in the public
[`@perkos/agent-sdk`](https://www.npmjs.com/package/@perkos/agent-sdk). The platform will inject a
pinned release of that verifier; it will not copy the SDK implementation.

The only published package is currently `0.1.0`. The direct `stacks-signed-tx-v1` verifier merged
later and must receive a new SDK release before the hosted settlement PR can depend on it.

## Planned PR sequence

1. Foundation: truthful discovery, PostgreSQL, migration runner, Docker and CI.
2. Merchant authentication and signed, short-lived request quotes.
3. Pinned SDK verifier, durable reservation and testnet settlement.
4. Reconciliation worker, confirmation receipts and delivery ledger.
5. Leather/headless examples and external clean-room quickstart.
6. Isolated sponsor relay only after the non-sponsored path passes review.

See [`docs/plans/2026-08-26-facilitator-foundation-design.md`](docs/plans/2026-08-26-facilitator-foundation-design.md)
for the approved design and security boundaries.

## Milestone 2 alignment

This platform helps produce a stronger SDK demo and external pilot, but it does not replace the M2
external security review, ten mainnet agents, five completed sBTC jobs, non-team wallets or
external developer feedback. M1 is approved and remains unchanged.
