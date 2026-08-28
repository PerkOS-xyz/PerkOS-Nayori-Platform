# External OAuth resource-server design

Date: 2026-08-27
Status: approved by Julio

## Identity and ownership

- `https://nayori.ai` is the protected resource and access-token audience.
- `https://oauth.nayori.ai` is the authorization-server issuer and JWKS origin.
- `https://api.nayori.ai` is the API, MCP and x402 resource server.

The private `PerkOS-Nayori-OAuth` service owns invitations, wallet challenges, OAuth clients and
the access-token signing key in a dedicated PostgreSQL database. Platform never imports that
private key. External mode verifies remote EdDSA JWKS, exact issuer and audience, token lifetime,
the `at+jwt` type and known scopes. It then loads the subject merchant from its own database and
requires that merchant to remain active.

Merchant API keys remain accepted for backward compatibility. OAuth cannot sign, sponsor or
approve an STX, sBTC or USDCx payment.

## Cutover and rollback

External mode is selected explicitly with `OAUTH_MODE=external`; partner-registration routes are
rejected by configuration in this mode. The API publishes canonical protected-resource metadata
and redirects issuer-owned metadata, token and JWKS compatibility routes to the external issuer.

The embedded issuer remains a rollback mode until external issuer health, JWKS, a clean client
credential flow, MCP authorization and quote authorization pass on the VPS. Mainnet settlement and
sponsorship remain disabled throughout this change. M1 contracts and deployments are unchanged.
