# Merchant authentication and signed quotes design

Date: 2026-08-26  
Status: approved for implementation  
Milestone: M2 — Agent SDK + Security Review + First Adoption

## Goal and release boundary

Add authenticated, request-bound quote issuance to the private Nayori Platform and pin the public
`@perkos/agent-sdk` release that owns the x402 canonicalization rules. This increment does not
accept payment payloads, verify signed transactions, reserve quotes, broadcast, confirm, sponsor
fees or deliver resources. Milestone 1 contracts remain unchanged.

Quote issuance is testnet-first and disabled by default. The endpoint exists only when
`QUOTE_ISSUANCE_ENABLED=true` and valid signing material is supplied. Discovery must report the
actual enabled state and continue to report settlement and sponsorship as false.

## Chosen trust model

Merchant resource servers authenticate with high-entropy bearer API keys. Nayori stores only a
lowercase SHA-256 digest and looks up that digest in PostgreSQL; the plaintext credential is shown
once by an offline provisioning command. Disabled merchants, missing credentials and malformed
keys fail with the same generic 401 response. The service never logs authorization headers,
request bodies, quote tokens or API-key digests.

Each merchant is preconfigured with allowed resource origins, audiences, recipients and named
route definitions. A quote request names a route and supplies only the protected request method,
URL and optional body. Network, asset, atomic amount, recipient, audience and maximum TTL come
from server-side route configuration. A stolen merchant credential therefore cannot redirect
funds or invent a new asset, recipient, price or audience.

Alternatives rejected for this increment:

- Wallet-signed challenges add nonce, wallet and delegated-operator semantics before merchant
  onboarding needs them. They remain a future authentication option for agent-owned merchants.
- OAuth client credentials require an authorization server and lifecycle that provide little
  additional protection for the initial allowlisted pilot.
- HMAC quote tokens cannot be independently verified by agents or resource servers.

## HTTP contract and quote flow

`POST /v1/quotes` accepts `Authorization: Bearer ny_mk_<base64url secret>` and a JSON body:

```json
{
  "routeId": "research-summary",
  "request": {
    "method": "POST",
    "url": "https://merchant.example/v1/research",
    "body": "canonical request body"
  }
}
```

The complete request body is capped by the existing 64 KiB limit. The service authenticates the
merchant, resolves the named route, canonicalizes and validates the protected request through
`@perkos/agent-sdk@0.2.0`, issues a quote with a server-selected lifetime no greater than five
minutes, computes its deterministic `ny1_` fingerprint and writes the quote plus a SHA-256 hash
of the signed token in one database operation.

The response contains the SDK quote, x402 payment requirements and a compact signed token. It does
not contain the API key or private signing material. Duplicate requests create independent
short-lived quotes; settlement will later enforce one-time consumption by quote ID, token hash,
fingerprint and transaction ID.

## Ed25519 signing and rotation

Quotes are signed as compact JWT/JWS tokens using Ed25519 (`alg=EdDSA`) and `jose@6.2.10`. Claims
include issuer, audience, merchant subject, quote ID, issued/expiry times and the complete quote.
Protected headers include a stable `kid` and `typ=nayori-quote+jwt`. The active private JWK is
loaded only from deployment secrets and must contain a unique `kid`; no key is committed.

`GET /.well-known/jwks.json` exposes only public JWK members. A deployment may also provide prior
public keys so quotes issued before rotation remain verifiable through their short TTL. Rotation
means installing the new private JWK, retaining the previous public JWK for at least the maximum
quote lifetime, then removing it. The service derives the active public JWK and rejects duplicate
key IDs, private members in the previous-key set, non-Ed25519 keys and invalid algorithms.

## Persistence and provisioning

The existing `merchants` and `quotes` tables already contain the required security invariants.
Migration 002 strengthens route configuration with database checks and adds an index for active
merchant lookup without changing the original migration checksum. Provisioning runs as a CLI
against PostgreSQL, validates the same merchant configuration used by the service, generates a
32-byte API-key secret with the Node.js CSPRNG, stores only its digest and prints the plaintext key
once. Re-running provisioning rotates the credential and replaces the allowlists atomically.

The route configuration shape is versioned. Version 1 maps route IDs to an exact method, origin,
audience, network, payment asset, atomic amount, recipient and quote TTL. Only the configured
Stacks network is accepted. Atomic amounts remain decimal strings and are converted to PostgreSQL
numeric values without JavaScript number coercion.

## Errors, abuse controls and observability

Authentication failures return generic 401 JSON with `WWW-Authenticate: Bearer`; disabled or
unknown routes return 404, policy mismatches return 403, malformed requests return 400 and a
database/signing failure returns a generic 500. No error discloses whether a merchant ID, API key,
route or signing key exists. All responses retain request IDs, no-store caching and security
headers.

The route retains the 64 KiB body cap and uses a per-process bounded rate limiter keyed by the
credential digest. This is an initial single-replica safeguard, not a claim of distributed quota
enforcement; the VPS edge must add a second limit. Logs record merchant ID, route ID, quote ID,
status and request ID only after successful authentication, never credentials or protected bodies.

## Verification and release gates

Tests cover malformed/missing/unknown keys, disabled merchants, exact route policy, canonical URL
and body binding, TTL bounds, STX/sBTC/USDCx route metadata, Ed25519 verification through the JWKS,
key rotation overlap, database failure, signing failure, request limits and continued absence of
settlement routes. Migration CI applies every migration twice against PostgreSQL 16.

The packaged SDK is pinned exactly to `0.2.0`; no local transaction-verifier code is copied. The
PR must pass lint, strict types, tests, build, full dependency audit and a real PostgreSQL
integration test. Deployment remains separate and will use secrets outside GitHub. Settlement is
the next security-focused PR only after this quote surface is reviewed.
