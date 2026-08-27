# Testnet verifier, durable reservation and settlement design

Date: 2026-08-27  
Status: approved by the existing M2 implementation sequence  
Milestone: M2 — Agent SDK + Security Review + First Adoption

## Goal and release boundary

Add authenticated payment verification and exactly-once broadcast for the direct Nayori x402
profile on Stacks testnet. The Platform must use the pinned public `@perkos/agent-sdk` verifier;
it must not copy transaction parsing or economic validation into the private service. A successful
verification is diagnostic only and never authorizes resource delivery. Settlement may return a
pending state, but payment is not complete until the later reconciliation increment confirms the
transaction on-chain.

This release does not change or redeploy any M1 contract. It does not enable mainnet settlement,
sponsorship, fee delegation, confirmation, reconciliation or delivery. Mainnet settlement remains
blocked in configuration even if an operator supplies a truthy feature flag.

## Chosen architecture

The API adds `POST /v1/x402/verify`, `POST /v1/x402/settle` and authenticated
`GET /v1/x402/settlements/:id`. Merchant authentication happens before quote or payment parsing.
Both write endpoints accept a compact signed quote, the x402 payment requirements and payload,
and the protected request metadata. The local Ed25519 verifier validates the token signature,
issuer, type, subject, quote ID, lifetime and embedded quote. PostgreSQL then proves that the token
hash and quote fields match an issued record owned by that merchant.

The SDK performs canonical request binding, origin-signature verification, network encoding,
recipient, amount, asset contract, memo and exact post-condition validation. Sponsored
transactions are rejected because sponsorship is a separate security boundary. `/verify` returns
normalized non-secret evidence and performs no mutation.

`/settle` repeats all verification, then atomically locks the quote, inserts one settlement in
`validated`, appends its first transition and moves the quote to `reserved`. A retry during quote
validity returns the existing settlement and never broadcasts again; after quote expiry the
authenticated status endpoint is the idempotent recovery path. Only the process that created the
reservation may submit the canonical raw bytes to the configured Hiro `/v2/transactions`
endpoint. The response txid must equal the SDK-derived txid.

## State and timeout behavior

The settlement state machine for this increment is:

```text
issued quote -> reserved + validated settlement
                          | accepted
                          v
                       broadcast
                          |
                          | timeout or ambiguous network response
                          v
                        pending

validated -> failed only for a definitive pre-acceptance broadcast rejection
```

Accepted, ambiguous and rejected attempts all leave the quote reserved so a signed payment cannot
be replayed with a replacement transaction. If the process crashes after reservation but
before persisting a broadcast outcome, the settlement remains `validated`; retries return that
record without rebroadcasting. The reconciliation worker in the next PR must resolve `validated`,
`broadcast` and `pending` by deterministic txid before any further action.

The database stores txid, payer, SDK version/checksum and SHA-256 of the canonical raw
transaction, never the transaction bytes, signed quote, merchant credential or request body.
Append-only transition rows record status changes without secrets.

## Configuration and discovery

`PAYMENT_VERIFICATION_ENABLED` and `SETTLEMENT_ENABLED` default to false. Verification requires
quote issuance. Settlement additionally requires verification, `STACKS_NETWORK=testnet`, a
testnet Stacks API origin and sponsorship disabled. Production startup fails closed for an invalid
combination. Broadcast has a short bounded timeout and no automatic retry.

Discovery and OpenAPI expose only enabled routes. When settlement is enabled they describe it as
testnet broadcast with confirmation pending, never as completed payment. The agent manifest and
`llms.txt` continue to state that delivery is unavailable and that a quote or verify result is not
proof of settlement.

## Errors and verification gates

Authentication failures remain generic 401. Malformed bodies return 400; token/quote/request or
transaction mismatches return 422 with a stable reason code; expired, revoked or consumed quotes
return 409. A definitive Hiro rejection returns a persisted failed settlement and 422. An
ambiguous timeout/network failure returns 202 with `pending`. Database errors return generic 500
and never trigger an unreserved broadcast.

Tests must cover signature and token tampering, token-hash mismatch, merchant isolation, expiry,
stable SDK rejection propagation, sponsored transactions, concurrent reservation, replay by quote and
txid, accepted broadcast, mismatched broadcast txid, definitive rejection, timeout ambiguity and
retry without rebroadcast. PostgreSQL CI must apply all migrations twice and exercise the atomic
reservation/state transitions. Lint, strict types, all tests, build and full dependency audit are
release gates. Deployment and live testnet broadcast remain separate, post-merge operations.
