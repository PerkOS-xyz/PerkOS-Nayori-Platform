# Direct S3 private evidence — QA storage verified, app not enabled

Nayori authorizes; agents upload directly to a **private, versioned S3 bucket** over HTTPS.
PostgreSQL stores only job binding, hash, size, expiry and exact S3 object/version identifiers.
No new contracts are required. This replaces the planned PostgreSQL ciphertext path, not live
production uploads. The older encrypted store remains unmounted; do not enable both backends.

## Protocol

All API calls require a wallet-bound OAuth token with the applicable `evidence:write` or
`evidence:read` grant; fresh issuer/merchant and on-chain role checks apply at each operation.

1. `POST /v1/private-evidence/prepare` with `{ "context": { ... } }` reserves quota, assigns a UUID
   and object key, and returns `{id, upload: {url, fields}, uploadExpiresAt, expiresAt}`.
2. Agent sends multipart form data **directly to S3**, including every returned field unchanged
   and the file last. Do not forward the Nayori OAuth token to S3. POST policy expires within
   five minutes and binds exact key, exact file size, content type, SHA-256 and SSE-S3 encryption.
3. `POST /v1/private-evidence/complete` with `{ "id": "..." }`: Nayori HEADs S3 with checksum mode,
   verifies size/type/checksum/encryption and requires a real version ID. First finalization wins.
   Caller-supplied S3 paths, versions, checksums or metadata are never accepted at completion.
4. `POST /v1/private-evidence/download` with `{ "id": "..." }`: after current authorization,
   returns a signed GET for the **stored version**, lasting at most60seconds and no later than
   retention expiry. Only completed files may be downloaded.

Routes now have **explicit QA-only runtime wiring**, disabled by default and not enabled in the
deployed app. No SDK/MCP release yet.
Limits remain8192bytes/file, text/plain or application/json, five files/16000bytes per job,
100000reservations/1GiB globally. Pending and expired reservations count until operator cleanup.
Quota failure, signing/network failure and expiry fail closed, not fallback to public storage.

## Security and operational limits

- Signed POST/GET capabilities can be shared/replayed until expiry; they are **not single-use**.
  Upload replay can create additional S3 versions even though final evidence remains version-pinned.
  Database quotas do not bound this replay storage cost: short TTL, request rate limits, monitoring
  and lifecycle cleanup of orphan/noncurrent versions are required before activation.
- Versioning is mandatory. HEAD without a real version denies finalization. Retention/lifecycle
  must not delete a pinned version merely because replay made it noncurrent.
- SSE-S3 encrypts at rest, not end-to-end; authorized AWS principals/S3 can access plaintext.
  No AES-GCM content/keyring in PostgreSQL for this backend. SSE-KMS is not enabled by this adapter.
- Checksums prove uploaded bytes match the provider's commitment, not that JSON/text is safe or
  semantically valid. Evaluator must bound downloads, validate UTF-8/JSON and treat evidence as
  untrusted data, never instructions. Browser download forces attachment/octet-stream.
- Signed URLs/form fields are credentials: never log, persist in DB, expose in public evidence,
  put on chain, include in model prompts, or forward OAuth tokens across origins.
- Revocation stops new authorizations, not already issued S3 capabilities. Up to60seconds of
  residual download access is intentional; immediate revocation requires proxy downloads.
- Approved policy:30days of access from the upload reservation, plus at most7additional days in
  backups. Retries/restores never extend expiry. Runtime fixes access TTL to30days; generic service
  constructors still take an explicit TTL for tests. Metadata backup does not back up objects.
  Backup infrastructure/retention must be configured and verified separately before activation.

## QA storage validation (2026-09-09)

A dedicated private QA bucket in us-east-1 was created and tested with synthetic bytes only.
Sixteen real AWS checks passed: public access block, versioning, SSE-S3, owner-enforced/no ACLs,
nonpublic bucket policy, exact QA CORS origin, successful direct POST, HEAD integrity/version,
anonymous GET rejection, signed download/attachment/no-store, wrong bytes/size/type/key rejection,
replay producing a new version while the pinned one remains readable, and expired GET rejection.
The TLS-only bucket policy was read back. Both synthetic object versions were deleted and the
bucket was verified empty, including delete markers. No production data was involved.

Tests used the operator's temporary CLI login on the Mac, never copied to the VPS or persisted
by the harness. This proves the S3 adapter, **not the operational service credential or the full
OAuth/SQL/S3/MCP/evaluator E2E**. First harness attempt used the wrong local Node version; Node22
rerun passed. No code change was needed in the S3 adapter.

A proposed least-privilege identity policy passed24per-resource IAM Simulator decisions:
encrypted TLS PutObject/GetObject/GetObjectVersion allowed only for the QA testnet prefix;
delete/version-delete/ACL writes, mainnet prefix and insecure transport denied. This policy was
**not attached**, and no IAM user, role or access key was created. Simulation is not live IAM proof.

Subsequent verification created a dedicated non-console QA service identity and attached the narrow
object policy. Its credential is stored only in an owner-only file outside Git on the operator Mac,
not on the VPS.22real AWS checks now pass with that service identity, including denied bucket listing,
version deletion and access outside the testnet prefix; both POST and GET expiry; and allowed/denied
CORS preflights. These are real HTTP preflights, not a browser automation test. The new cleanup adapter
deleted the two synthetic versions using a separate operator identity. It is not an end-to-end app test.

The AWS SDK decorates credential identity objects. The adapter copies the immutable secret snapshot
before passing it to AWS; the initial live test exposed this incompatibility and a regression test
covers the fix. Public QA discovery confirms audience `https://api.qa.nayori.ai` (not the landing origin).

## QA runtime and operator cleanup

`S3_EVIDENCE_QA_ENABLED` is absent/false by default. Only the exact string `true` opts in; enabled
configuration requires Stacks testnet, the testnet Hiro API, OAuth issuer `https://oauth.qa.nayori.ai`
and audience `https://api.qa.nayori.ai`. Mainnet/production origins are rejected. Configure:

- `S3_EVIDENCE_BUCKET`, `S3_EVIDENCE_REGION=us-east-1`, `S3_EVIDENCE_ACCOUNT_ID`;
- `S3_EVIDENCE_CONTRACTS`: comma-separated allowed deployed testnet contracts;
- `S3_EVIDENCE_CREDENTIALS_FILE`: absolute, canonical, non-symlink JSON file, mode0600, owned by
  the process/root, at most8KiB: `accessKeyId`, `secretAccessKey`, optional `sessionToken`.

Never put actual credentials in these docs, Git, logs or agent prompts. Runtime has no implicit
AWS environment/login fallback. Rotating a persistent service credential requires a controlled restart.
Admission allows10prepare and60complete/download requests per wallet/operation/minute per process,
with bounded memory. This supplements SQL quotas; it is not a shared distributed rate limiter.

Migration008 adds `purged_at` tombstones. The separate `npm run evidence:cleanup:qa` CLI uses the
same explicit QA settings plus `S3_EVIDENCE_CLEANUP_CREDENTIALS_FILE` for a separate privileged
operator identity. It defaults to dry-run and one row; `S3_EVIDENCE_CLEANUP_BATCH` is1..10.
Only `CONFIRM_QA_EVIDENCE_PURGE=yes` executes deletion. Never grant delete/list to the HTTP identity.

Cleanup locks eligible rows (expired, or incomplete uploads more than60seconds beyond upload expiry),
deletes only enumerated exact object versions/markers, verifies absence, then writes the tombstone.
S3 failure rolls SQL back; retries safely remove remaining versions. Active rows/pinned versions
are untouched. Truncated listings, more than100versions, wrong prefixes and unversioned objects
fail closed for operator review. Tombstones cease counting toward capacity; metadata pruning waits
until original access expiry plus7days. A restored backup must reapply expiry/cleanup before access.
SQL deletion is not physical erasure of WAL/backups. No public maintenance API exists.

## QA operations verified

The approved release is deployed in QA with migrations007/008; application uploads remain disabled.
A separate operator timer runs a bounded batch of at most10 eligible rows every five minutes.
Its IAM identity can list the QA prefix and delete exact versions, but cannot read or upload objects.
Eight real AWS checks verified its permissions and idempotent cleanup using synthetic versions.
The API does not receive this cleanup credential.

A dedicated daily metadata-only PostgreSQL backup runs with an hourly retention check. Its own
daily copies older than six days are removed, leaving margin below the approved seven-day backup
cap during normal operation. Timer failure/downtime requires operator intervention; this is not
an unconditional deletion guarantee. Unrelated/historical backups are not purged by this job.

Four synthetic recovery checks passed after destroying the fixture source database and restoring
its dump into a new database: metadata restored, exact S3 version preserved, original bytes
downloaded, and expired restored metadata denied access. The synthetic object version and fixture
containers were removed afterward. This validates metadata recovery while the object remains in
S3, **not recovery from bucket loss**. Versioning is not an independent backup. Production was unchanged.

## QA operational email alerts

The QA watchdog checks timer/service failures, staleness and missing/unsafe metadata backups.
It now sends through Resend, not SNS, using a separate sending-only domain-scoped credential.
QA subjects always start with `[QA]`; development and production must use their own configuration
and `[Dev]` / `[Prod]` labels. No object contents, credentials or raw exceptions appear in emails.

The notifier persists a pending request before sending and reuses its idempotency key when
retrying. Unchanged conditions are suppressed, changed failure notices are rate-limited and a
recovery transition may notify. Ambiguous requests older than23hours require operator review;
provider idempotency is not an indefinite exactly-once guarantee. State loss also requires review.
Local notifier failures remain visible as systemd failures; a broken email path cannot reliably
report its own failure through that same path.

Nine policy checks passed locally and on the VPS. A VPS-generated test email was confirmed
delivered by Resend; repeating the test produced no duplicate. Healthy baseline checks sent no
email. These checks do not yet inject a live operational failure/recovery cycle. Independent
host-loss monitoring, email-path monitoring and replay-cost alerts remain outstanding.

## Remaining activation gates

1. Preserve verified QA bucket settings: Block Public Access, bucket-owner-enforced ownership/no
   ACLs, versioning Enabled, SSE-S3 and TLS-only policy. Production needs a separate bucket.
2. Mount the provisioned restricted service credential into the QA runtime securely; never root.
   Do not transfer operator cleanup permissions to the HTTP service or agents.
3. Exact QA origin CORS for browser POST; agents do not require CORS. Do not use wildcard origins.
4. Add independent outage/email-path and replay-cost alerting; validate object-loss recovery and retention
   across any additional backups. Never purge rows first.
5. Migrations007/008 are applied in QA. Opt in only after the remaining gates pass, with issuer evidence identity
   enabled and explicit grants. Do not enable the old write/read factory alongside the new backend.
6. SDK/MCP helpers, evaluator private reads, public-output leak checks, browser workflow and full QA E2E.

Current validation: 337 tests pass in a disposable VPS PostgreSQL environment, including concurrent
quota reservations, first-version finalization, expiry, cleanup rollback and tombstones;
lint/typecheck/build pass. HTTP tests use real JWT verification with fixture issuer/job data.
Automated unit S3 tests mock AWS commands; the separate 22-check restricted-identity AWS probe
covers real uploads, downloads, expiration, CORS and permission boundaries. Fixture versions were
deleted using the operator cleanup adapter. Application containers remained unchanged. This is
not yet a deployed OAuth/SDK/MCP/evaluator end-to-end workflow.

## AWS references

- [POST policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
- [Presigned URL capabilities](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Upload checksums](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)
