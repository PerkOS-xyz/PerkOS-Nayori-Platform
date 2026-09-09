# Private evidence: security foundation and activation gates

## Status

This QA source introduces **security primitives, not an available upload service**. No routes,
database migrations, OAuth grants or MCP tools are enabled by this change. Production is unchanged.
The private path must not fall back to public files or bearer tokens embedded in URLs.

## Identity and job authorization

`authenticateEvidence` validates an EdDSA access token using the configured issuer's keys,
issuer, resource audience, `at+jwt` type, required expiry/issued-at claims and a maximum fifteen-minute
lifetime. It requires the intended `evidence:read` or `evidence:write` scope and a valid network-specific
Stacks wallet. Merchant API keys do not prove wallet identity and are rejected by this path.
The caller must provide an authoritative active-client/tenant check; lookup failure denies access.
The existing merchant authenticator remains unchanged. The issuer does not grant these new scopes yet.

`authorizeEvidence` requires fresh data from a trusted, allowlisted chain adapter. Never pass a job,
identity, network or contract chosen by an LLM as an authoritative backend result.

| Role | Read | Write |
| --- | --- | --- |
| Job consumer | Its assigned-provider evidence, including settled jobs | No |
| Assigned provider | Its job's evidence, including settled jobs | Only funded jobs with positive escrow |
| Designated evaluator | Submitted, decision-pending or disputed jobs with positive escrow | No |
| Other wallet | No | No |

Provider reassignment, unknown jobs, unexpected network/contract/ID and unavailable chain reads
deny access. Neither knowing a file hash nor being active under the same merchant grants access.
Authentication and authorization must run for **every** read before storage lookup/decryption.
An integration must bound the time between chain authorization and the storage operation.

## Encryption

`sealEvidence` / `openEvidence` use AES-256-GCM with a random 96-bit nonce and authenticated metadata:
purpose, envelope version, key ID, network, contract, job, provider, content hash, MIME and byte length.
Changed context, ciphertext, tag or key must fail. UTF-8 text and valid JSON are supported up to
8192 bytes per artifact. These helpers do not enforce aggregate storage quotas or retention.

Keys must come from an operator-managed secret store, separate from the data store and its backups.
Never send encryption keys, wallet keys or model credentials to an MCP prompt. A key ID supports
selecting the correct key but is **not** a completed rotation, deletion or recovery implementation.
The service operator and authorized evaluator process can access plaintext in memory; this is not
end-to-end encryption against the operator. Ciphertext at rest alone is not access authorization.

## Mandatory gates before enabling private uploads

- Durable, encrypted storage with atomic per-job/file/global quotas, immutable content, bounded
  concurrency, retention/deletion policy and key rotation/recovery tests. No in-memory production substitute.
- Issuer support for narrow scopes and reliable activation/revocation checks; authentication must preserve
  wallet identity rather than returning only a merchant. Evaluator uses its own constrained identity.
- Private HTTP upload/download with authorization before existence checks; no anonymous GET, public
  object ACL, credential-bearing URL, CDN cache or request/response-body logging.
- MCP tools with operator-owned API authentication, byte limits and no arbitrary filesystem/URL fetching.
- Evaluator reads privately and does not leak evidence into public explanations, artifacts, logs,
  metrics or prompts sent to an unauthorized third-party provider. Private evaluation outputs need
  their own access controls; do not assume existing public status responses are safe.
- Full HTTP/database/MCP/evaluator E2Es, including cross-job access, revocation, concurrent uploads,
  tampering, restarts, retries and public-output checks, in QA before production promotion.

The unit tests cover primitives with generated test keys and injected chain/activation fixtures.
They do not establish database durability, operational key security or end-to-end private evidence support.
Descriptions, criteria and commitments already placed on-chain remain public. Private artifacts
must not be pasted into on-chain descriptions or public explanations.

x402 spending remains a separate authorization and implementation gate; an upload scope does not
grant payment authority, and an escrow permit does not authorize an x402 purchase.
