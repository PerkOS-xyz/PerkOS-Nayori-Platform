# Mainnet direct-commerce boundary

## Decision

Nayori will run the public `api.nayori.ai` resource server and the isolated
`facilitator.nayori.ai` settlement service on Stacks mainnet. QA remains pinned to Stacks testnet.
The initial production recipient is the existing mainnet deployer
`SP2K7PV5NXBNRV510S6DCA6RFMTFHAF3ZPK6ZSXPH`; the recipient remains a versioned merchant-route
setting rather than application input.

## Safety boundary

Mainnet settlement stays fail-closed. Enabling it requires quote issuance, payment verification,
settlement, reconciliation and delivery flags plus the exact acknowledgement
`CONFIRM_MAINNET_SETTLEMENT=yes`. A mainnet process must reject the canonical Hiro testnet URL,
and a testnet process must reject the canonical Hiro mainnet URL. Sponsorship remains impossible.
The buyer still creates and signs the STX, sBTC or USDCx transfer; Platform stores no buyer key.

The facilitator preserves the existing economic invariants: the signed transaction must match the
request-bound quote, network, asset, amount, recipient, memo and post-conditions; each quote and
transaction is reserved once; broadcast is attempted once; resource delivery remains unavailable
until canonical confirmation and signed-receipt creation. Mainnet activation does not deploy or
invoke escrow contracts.

## Release and rollback

The code release will update capability documents so status and descriptions name the configured
network instead of hard-coding testnet. Production merchant routes will be reprovisioned for
`mainnet` with mainnet STX and USDCx definitions. The existing merchant credential and signing
key remain external to GitHub. Deployment builds the exact merged commit on the VPS, activates the
facilitator and worker together, then activates the public API. Gates require healthy containers,
`stacks:1` discovery, `SP...` payment recipients and the canonical mainnet USDCx contract. A
pre-change database/config backup and retained Compose files provide rollback. No payment is
broadcast during rollout validation.

