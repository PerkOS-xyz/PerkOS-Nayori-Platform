# Private evidence: security foundation and activation gates

## Status

This QA source introduces **security/storage primitives, not an available upload service**. Migration
006 creates an empty encrypted-storage table when migrations are run. No routes, OAuth grants,
operational encryption keys or MCP tools are enabled by this change. Production is unchanged.
The private path must not fall back to public files or bearer tokens embedded in URLs.

## Identity and job authorization

`authenticateEvidence` validates an EdDSA access token using the configured issuer's keys,
issuer, resource audience, `at+jwt` type, required expiry/issued-at claims and a maximum fifteen-minute
lifetime. It requires the intended `evidence:read` or `evidence:write` scope and a valid network-specific
Stacks wallet. Merchant API keys do not prove wallet identity and are rejected by this path.
The caller must provide an authoritative active-client/tenant check; lookup failure denies access.
The existing merchant authenticator remains unchanged. The companion issuer supports explicit evidence
grants, but their issuance and identity endpoint remain disabled in QA until activation gates pass.

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

### Issuer identity client (inactive)

`createIssuerEvidenceIdentityCheck` builds the `activeIdentity` callback for `authenticateEvidence`
per request, using the **same** access token. It checks the local merchant before and after a
POST to the configured HTTPS issuer's `/oauth/evidence/identity`. The requested evidence scope
travels in a header; no body, query token, cookies, redirects or authorization cache are used.
It requires an exact identity/scope match, valid remaining expiry and a strict JSON response
of at most 1024 bytes. A five-second deadline covers local lookups, fetch and streamed response.
Any failure denies access. Trusted database adapters should also enforce their own query timeouts;
timing out authorization does not cancel arbitrary database callbacks internally.

The companion OAuth source must enable its identity flag and grant evidence scopes explicitly.
This module is **not wired into server routes**; no issuer calls or configuration changes occur
in the existing runtime. Local merchant status is separate from issuer client status, and both
are separate from on-chain job authorization. `agent:self` is not a private evidence grant.

### Durable storage adapter (inactive)

`PostgresPrivateEvidenceStore` accepts bytes only after an injected fresh authorization callback.
It validates/hash-checks and encrypts before SQL. Each read reauthorizes before lookup and again
before decrypting; the integrating service must supply real token/chain checks, never a no-op.
Callbacks are an internal trust boundary, not externally supplied code or a replacement for OAuth.

One transaction-scoped PostgreSQL advisory lock serializes capacity checks and writes across
processes, with bounded SQL/lock waits. Limits are five files / 16000 plaintext bytes per job,
8192 per file, plus operator-selected global record/envelope-byte caps (hard ceilings 100000 records
and 1 GiB). These caps exclude PostgreSQL indexes, WAL and backups; provision disk separately.
No plaintext is sent to SQL. Immutable duplicate uploads return the original expiry without
overwriting ciphertext or extending retention. Unknown/expired/tampered records fail closed.

Retention duration is mandatory configuration, not a default policy. Expired records remain counted
and stored: expiry denies API reads but is **not physical deletion**, backup erasure or cryptographic
shredding. A deletion/backup/rotation/recovery procedure remains an activation gate. Active-key
selection plus reading older keys is tested. An inactive operator batch re-encryption library is now
available below; coordinated operational rotation and key retirement are not yet complete.
There are no new production connections, runtime keys, routes, or background cleanup jobs.

The PostgreSQL test uses a disposable schema and fixture keys, exercises concurrent retry/quota
behavior, re-creates the adapter, tests provider reassignment, evaluator restrictions, tampering
and expiry. It is not an HTTP/MCP/evaluator E2E, nor a recovery-from-backup test.

### Private HTTP factory (inactive, not mounted)

`createPrivateEvidenceHttp` composes token verification, the HTTPS issuer identity client, fresh
chain authorization and the durable store interface. The production server does not instantiate or
mount it. Its tests inject storage/chain fixtures; they are not a deployed database/MCP E2E.

- `POST /v1/private-evidence/write`: JSON `{ "context": { ... }, "content": "UTF-8 text" }`.
- `POST /v1/private-evidence/read`: JSON `{ "context": { ... } }`, authenticated attachment response.
- Context is the exact network/allowlisted contract/job/provider/SHA-256/MIME/size binding documented
  above, not authoritative job state. No credential or artifact metadata belongs in a query URL.
- Bearer authentication and current issuer/merchant checks happen before body buffering. Scope and
  chain authorization repeat before entering storage and through its callbacks. Reads recheck again
  before exposing plaintext. Consumer uploads, changed assignments and revoked clients fail closed.
- JSON transport is capped at 64 KiB (to accommodate escaped text), five seconds per body and eight
  in-flight operations per factory. Actual artifacts remain limited to 8192 bytes by the store policy.
  Trusted chain/key/database adapters must bound their own I/O; this is not a distributed rate limiter.
- No anonymous GET, cookies, query credentials, compressed bodies, public URLs, CORS allowance,
  body logging or cache. Responses use no-store, nosniff and attachment/CSP protection. Failures have
  one generic403 payload so storage existence/errors do not leak through messages.
- The reverse proxy must enforce public HTTPS, reject oversized headers, disable caching and avoid
  sensitive request/response logging. Internal transport encryption is a separate deployment concern.

### Remaining integration and operational work

### Chain adapter and explicit runtime assembly (inactive)

`createPrivateEvidenceChain` uses only the operator's HTTPS node and allowlisted contracts. It
checks `/v2/info` network and sync status, resolves the tip through `/extended/v2/blocks/{height}`,
checks canonical hash/height and block age (maximum five minutes, thirty seconds future tolerance),
then reads `get-job` and `get-escrow-balance` pinned to the **index_block_hash**, not the block hash.
It checks the current tip again before returning. Moving tips, stale nodes, wrong networks,
malformed/noncanonical Clarity, unexpected principals or failed reads deny access; callers may
retry, but no stale authorization is cached. A five-second total deadline and 32KiB response caps
bound remote I/O. This intentionally favors denial over availability during node lag or tip changes.
The configured node remains a trusted data source; HTTPS is not an independent consensus proof.

`createPrivateEvidenceRuntime` assembles the bounded PostgreSQL pool (eight connections, five-second
connection/query/statement limits), encrypted store, Platform-local active merchant query, the
issuer's fixed `/oauth/jwks.json`, chain adapter and HTTP factory. It takes an explicit operator
keyring and retention/quota policy, and exposes `close()` for pool shutdown. Construction does not
run migrations, create credentials or mount routes in `server.ts`. No private keys enter request data.

The HTTP/PostgreSQL integration test runs a real loopback server against a disposable database,
with signed fixture tokens and simulated issuer/chain responses. It covers concurrent immutable
retries, ciphertext-only SQL, consumer/provider/evaluator roles, new HTTP/store instances reading
the same persisted record, revocation, cross-job denial and ciphertext tampering. The loopback
fixture uses HTTP without secrets; it is not a public TLS deployment, an operational keyring test,
a process crash/recovery test, or a complete MCP/evaluator E2E. Live testnet read-only checks of the
chain adapter are separate from that fixture integration.

### Activation checklist

### Operator keyring and lifecycle primitives (inactive)

`loadPrivateEvidenceKeyring` loads an operator-supplied JSON file once per process. The path must
be absolute and canonical (no symlink components); the file must be regular, single-link, mode0600,
owned by the process user or root and at most8192bytes. Schema: `activeKeyId` and `keys`, each entry
having `id` and canonical base64 `keyBase64` encoding exactly32bytes. At most eight distinct IDs and
distinct key materials are allowed; the active ID must exist. Reads return copies. File/config errors
are generic. This is not an HSM, remote signer or guarantee of memory zeroization.

The file belongs outside repositories and database backups; deliver it through a protected operator
channel and mount read-only. No operational file is generated or deployed by this change. Every
writer must restart with the new active key before retiring old material; old processes otherwise
continue encrypting with their loaded snapshot. Keep prior keys for reads and backup recovery.

`PrivateEvidenceMaintenance` is an operator-only library, not an HTTP/MCP endpoint or scheduler:

- `rotateBatch(limit)`:1–100records, fixed network/contract scope, same capacity advisory lock as
  uploads. Decrypt/authenticate and re-encrypt atomically; corrupted/missing-key records abort the
  whole batch. Hashes, metadata and expiry are preserved. Increased envelope size must fit global
  storage capacity. An inactive key can still be referenced outside this maintenance scope.
- `purgeExpired(limit, execute=false)`: dry-run by default; explicit execution deletes only expired
  scoped rows, up to100. It never deletes keys or touches backups. This is logical PostgreSQL row
  deletion, not disk/WAL/replica erasure, immediate filesystem reclamation or cryptographic shredding.
- After a purge, no immutable tombstone remains; a still-authorized funded provider may upload the
  same bytes as a new record. Do not describe this as permanent content revocation.

Operational retention and backup windows remain an explicit policy decision, not baked-in defaults.
Expiry always blocks reads even in a restored backup, but restoration can resurrect previously
purged ciphertext. Before reopening restored data, apply retention/deletion policy and verify keys
and current identity/job authorization. Do not retire any key until all writers, all relevant records,
and every retained backup/replica have been accounted for. No automatic key destruction is provided.

Tests use temporary fixture key files and disposable PostgreSQL: file validation, copy isolation,
rotation/read with current keys, unchanged expiry, batch rollback on tampering, dry-run, scope,
idempotent purge and active-record preservation. A full pg_dump/restore plus operational key recovery
exercise remains required before activation; these tests must not be presented as that exercise.

### Remaining activation work

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
