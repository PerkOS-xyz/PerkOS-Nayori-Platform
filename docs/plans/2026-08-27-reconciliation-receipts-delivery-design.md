# Testnet reconciliation, confirmation receipts and delivery ledger design

Date: 2026-08-27  
Status: approved by the integrated M2/product execution sequence  
Depends on: Platform 0.3.0 merge `33362e5d2471ad55aee8b0557654995671fa6cb4`

## Goal and boundary

Resolve `validated`, `broadcast` and `pending` settlements by their deterministic Stacks txid,
require canonical successful execution and configurable confirmation depth, issue one signed
receipt and create a merchant-controlled idempotent delivery ledger. No paid resource is released
from a quote, verify-only result, broadcast response or ambiguous chain observation.

This increment remains testnet-only and changes no M1 contract. It does not enable mainnet,
sponsorship, arbitrary callbacks or custody. The platform never receives buyer private keys and
does not proxy an arbitrary merchant URL.

## Chain source

The reconciler reads `GET /extended/v3/transactions/{txid}?include=result`. Hiro v3 returns only
canonical transaction data and intentionally removed the legacy `canonical` field. A 404 or
`pending` status is unresolved; `success` must include the exact txid and a valid block height and
hash. Abort and dropped states are terminal failures. Unknown shapes, network errors, rate limits
and 5xx responses are ambiguous and never authorize confirmation.

Confirmation depth is computed from the node RPC `GET /v2/info` field `stacks_tip_height` as
`tip - blockHeight + 1`. A tip below the transaction block, an invalid block, or depth below the
configured minimum remains pending. These choices follow the current public Hiro v3 migration and
transaction documentation:

- https://docs.hiro.so/en/apis/stacks-blockchain-api/v1-to-v3-migration
- https://docs.hiro.so/en/apis/stacks-blockchain-api/reference/transactions/get-transaction

## Worker and leases

Reconciliation runs as a separate process. PostgreSQL claims a bounded batch with
`FOR UPDATE SKIP LOCKED`, increments attempt count and sets a short lease. Network I/O happens
outside the database transaction. A crash leaves the settlement recoverable after lease expiry.
There is no broadcast in the reconciler.

Observations are applied only while the settlement remains in an active state. Confirmation,
terminal failure and delivery transitions are append-only. Re-running a batch returns the same
receipt and cannot recreate delivery state.

An ambiguous initial broadcast is observed but never blindly rebroadcast. After configured depth,
this testnet increment stops sampling the confirmed settlement and does not revoke a receipt after
a later deep reorganization. Mainnet enablement requires a separate finality and recovery review.

## Receipt

On confirmation the service creates a deterministic receipt ID, signs a JWT with the existing
Ed25519 service key and type `nayori-settlement-receipt+jwt`, and stores the token. Claims bind:

- settlement, quote and merchant IDs;
- network, asset, amount and recipient;
- payer and txid;
- canonical block height/hash, confirmations and confirmation time;
- issuer, audience, subject, key ID and issued-at time.

The same public JWKS validates quotes and receipts, while the protected JWT type prevents
cross-protocol interpretation. The quote becomes `consumed` only in the same transaction that
persists confirmation and the receipt.

## Delivery ledger

Confirmation creates one `delivery_pending` row with a deterministic delivery ID and request
digest. The platform does not call the protected merchant URL. Instead, the authenticated merchant
resource server claims the delivery record and uses its delivery ID as the idempotency key when it
serves the paid resource.

`POST /v1/x402/settlements/:id/delivery/claim` changes `delivery_pending` to `delivering` and
returns the signed receipt. Repeated claims return the same delivery ID and receipt, not a new
attempt. `POST /v1/x402/settlements/:id/delivery/complete` accepts only a lowercase SHA-256 digest
of the delivered response. Repeating the same digest is idempotent; a different digest conflicts.

This ledger makes the protocol retry-safe but cannot make an arbitrary external side effect
mathematically exactly-once. Merchant handlers must deduplicate by delivery ID. No webhook or
server-side request forgery surface is introduced.

## Configuration and discovery

`RECONCILIATION_ENABLED` defaults to false and requires testnet settlement. Confirmation depth,
batch size, poll interval and lease duration are bounded. `DELIVERY_LEDGER_ENABLED` requires
reconciliation. Discovery advertises confirmation and delivery ledger only when enabled, and
states that the merchant still owns resource delivery.

## Gates

Tests cover v3 canonical-success parsing, txid mismatch, 404/pending, abort/drop/problematic-skip,
invalid block/tip, insufficient depth, API ambiguity, lease recovery, concurrent workers,
deterministic receipt creation, merchant isolation, claim retry, completion retry and digest
conflict. PostgreSQL 16 CI applies migrations twice. Lint, strict types, all tests, build and a
high-severity dependency audit are mandatory. Deployment and live testnet confirmation remain
post-merge operations on the VPS.
