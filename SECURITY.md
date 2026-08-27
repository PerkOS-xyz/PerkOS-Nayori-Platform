# Security policy

Nayori settlement infrastructure is security-sensitive and this repository is private. Do not
open a public issue containing a vulnerability, transaction payload, credential, wallet identity
or infrastructure detail.

Report suspected vulnerabilities through a private GitHub Security Advisory in this repository or
contact the PerkOS maintainers through an already-established private channel. Include affected
commit, reproduction conditions, expected invariant, observed behavior and whether any real funds
or external systems were involved.

Do not test settlement behavior against mainnet, broadcast a transaction, access another user's
data or attempt persistence without explicit written authorization. Read-only reproduction and
local/testnet fixtures are preferred.

The current release may enable invitation-bound wallet enrollment, OAuth client credentials, MCP,
quote issuance, verify-only checks, one testnet broadcast attempt,
leased reconciliation and signed receipts after canonical confirmation depth. A quote, successful
verification, `broadcast` or `pending` state is not confirmed payment. The delivery ledger gives
the merchant a stable idempotency key; it does not make an arbitrary external side effect
exactly-once and does not authorize Nayori to proxy merchant URLs. Mainnet and sponsorship remain
unavailable. Treat any private JWK output, plaintext merchant credential, transaction bytes at
rest, plaintext invitation or OAuth client secret after its one-time response, replayable wallet
challenge, receipt issued before confirmation or credential-bearing log as a release-blocking
issue. The OAuth signing key must remain separate from the quote-signing key, and OAuth must never
be treated as authority to sign a wallet payment.

The testnet worker does not blindly rebroadcast ambiguous submissions. After it signs a receipt at
the configured canonical depth, this release does not continuously recheck or revoke that receipt
for a later deep reorganization. Choose confirmation depth conservatively and treat mainnet support
as blocked on a separate review of finality, reorganization handling and operational recovery.
