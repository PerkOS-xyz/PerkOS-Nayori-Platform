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

The current foundation release does not enable quote issuance, verification, settlement,
sponsorship or resource delivery. Treat any accidental appearance of those capabilities as a
release-blocking issue.
