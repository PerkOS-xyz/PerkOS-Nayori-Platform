# Partner pilot OAuth, wallet binding and MCP design

Date: 2026-08-27  
Status: approved for implementation

## Outcome

Prepare Nayori's existing testnet settlement platform for an invite-only external partner pilot.
Partner agents authenticate through standards-discoverable OAuth, remain bound to a Stacks wallet
they prove they control, and can discover and invoke real Nayori capabilities through MCP. The
wallet or the partner's isolated signer continues to authorize payments separately; Nayori never
receives a seed phrase or private key.

This increment does not enable mainnet settlement, sponsorship or automatic resource proxying. The
existing quote, verifier, single-broadcast reservation, reconciliation, signed receipt and delivery
boundaries remain authoritative.

## Alternatives considered

1. Static well-known metadata only is small but would advertise services that do not exist.
2. A hosted identity provider would shorten OAuth implementation but would not prove control of the
   Stacks wallet and would create a new critical dependency before the pilot.
3. Native wallet-bound registration plus a small OAuth authorization server reuses the current
   PostgreSQL and Hono boundaries, provides standard tokens to agents and keeps wallet payment
   authority separate. This is the selected approach.

## Registration and trust model

An operator first creates a single-use invitation for one existing merchant. Only a SHA-256 digest
of the invitation is stored; the raw invitation is printed once. The partner requests a short-lived
challenge with the invitation, Stacks network and wallet address. The server returns an exact,
domain-bound plaintext message containing the service origin, challenge ID, nonce, network, wallet,
merchant and expiration.

Leather or another compatible wallet signs that exact message through `stx_signMessage`. The
registration endpoint verifies the signature and public key, derives the expected Stacks address
for the selected network, atomically consumes the invitation and challenge, and creates one OAuth
client linked to the merchant and wallet. It returns `client_id` and `client_secret` once. Only a
secret digest is stored.

Challenges expire within five minutes, are single-use and cannot change merchant, origin, wallet or
network. Invalid signatures, address mismatches, expired/replayed challenges and reused invitations
fail closed without creating a client.

## OAuth contract

The authorization server supports only the OAuth 2.0 `client_credentials` grant with
`client_secret_basic`. This matches headless partner agents and does not claim browser authorization
code or OIDC identity flows that do not exist.

Implemented discovery and runtime endpoints:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/oauth-protected-resource`
- `GET /oauth/jwks.json`
- `POST /oauth/token`
- `GET /auth.md`

Access tokens are short-lived Ed25519-signed JWTs with exact issuer, audience, subject, merchant,
wallet, network and space-delimited scope claims. OAuth uses separate signing material from quote
signing. Requested scopes must be a subset of the client grant. Initial scopes are
`catalog:read`, `quotes:create`, `payments:verify`, `payments:settle`, `payments:read` and
`mcp:invoke`.

Existing merchant API keys remain supported for backward compatibility. OAuth bearer tokens and
merchant keys resolve to the same merchant isolation context, but authorization is enforced by
route-specific scopes before service invocation.

## MCP runtime

`POST /mcp` is a real, stateless Streamable HTTP JSON-RPC endpoint protected by an OAuth token with
`mcp:invoke`. It supports `initialize`, `ping`, `tools/list` and `tools/call`. The first tool set is
intentionally bounded:

- `nayori_supported` returns the same truthful capability document as `/supported`;
- `nayori_request_quote` invokes the existing merchant-bound quote service and requires
  `quotes:create`;
- `nayori_get_settlement` returns only the caller merchant's settlement and requires
  `payments:read`.

Unknown methods, tools, invalid inputs and missing scopes return structured JSON-RPC errors without
leaking internal exceptions. No MCP tool accepts transaction signing material or broadcasts outside
the existing settlement service.

The server publishes an experimental Server Card at
`/.well-known/mcp/server-card.json`, marks the specification status accurately, and declares only
the implemented HTTPS Streamable HTTP endpoint.

## Configuration and rollout

The following gates default to false:

- `OAUTH_ENABLED`
- `PARTNER_REGISTRATION_ENABLED`
- `MCP_ENABLED`

OAuth requires a dedicated private Ed25519 JWK, an HTTPS issuer in production and a bounded access
token TTL. Partner registration requires OAuth. MCP requires OAuth. The service will not start when
these relationships or signing material are invalid.

After merge, the VPS image is built from the exact merge commit. The production hostname continues
to use Stacks testnet. Flags are enabled only after migrations, key generation, one merchant-bound
invitation, clean-room token acquisition, MCP discovery, quote flow, edge limiting, backup and
rollback validation pass. Mainnet remains rejected by configuration.

## Persistence

Migration 005 adds:

- `partner_invitations` with digest, merchant, scopes, expiry and one-time consumption;
- `wallet_auth_challenges` with nonce digest, exact message digest, wallet/network/origin binding,
  expiry and one-time consumption;
- `oauth_clients` with merchant/wallet binding, secret digest, allowed scopes, active/revoked state
  and audit timestamps.

Foreign keys preserve merchant isolation. Unique constraints and row locks make invitation,
challenge and client creation atomic. Raw invitation codes, client secrets, access tokens,
signatures and exact challenge messages are not logged.

## Testing and evidence

Tests must cover configuration gates, migration idempotency, one-time invitation/challenge use,
expiration, network/address/signature mismatch, OAuth Basic parsing, secret hashing, scope
narrowing, JWT issuer/audience/signature/expiry, merchant isolation, all MCP methods/tools and
failure redaction. PostgreSQL integration must prove concurrent registration produces one client.

The hosted CI gate remains lint, strict TypeScript, unit tests, PostgreSQL migrations/integration,
build and zero high-severity npm advisories.
