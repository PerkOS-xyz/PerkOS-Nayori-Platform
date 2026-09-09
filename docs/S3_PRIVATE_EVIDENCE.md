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

Routes exist as an **unmounted factory**, not available public endpoints. No SDK/MCP release yet.
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
- No automatic retention default: constructor requires an explicit operator choice. Proposed
  30+7day policy remains unapproved. Metadata backup does not back up the object contents.

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

## Remaining activation gates

1. Preserve verified QA bucket settings: Block Public Access, bucket-owner-enforced ownership/no
   ACLs, versioning Enabled, SSE-S3 and TLS-only policy. Production needs a separate bucket.
2. Least-privilege service IAM for exact evidence prefix; no list/public/delete-version permission
   for agents. Credentials only backend via trusted credential chain, never SDK config or Git.
3. Exact QA origin CORS for browser POST; agents do not require CORS. Do not use wildcard origins.
4. Agreed retention, pinned-version-safe orphan cleanup, replay-cost controls, rate limits, bucket
   cost alarms and recovery test covering object versions **and** metadata. Never purge rows first.
5. Apply migration007, assemble bounded PG pool and adapters, mount factory with trusted OAuth/chain
   dependencies. Do not enable the old write/read factory alongside the new backend.
6. Repeat AWS tests using the restricted operational service identity, then SDK/MCP helpers,
   evaluator private reads, public-output leak checks and full QA E2E. Test POST expiry and actual
   browser-origin behavior as well; the completed run checked GET expiry and bucket CORS config.

Current validation:318tests pass in a disposable VPS PostgreSQL environment, including concurrent
quota reservations, first-version finalization and expiry; lint/typecheck/build pass. HTTP tests
use real JWT verification with fixture issuer/job data. Automated unit S3 tests mock AWS commands;
the separate16check operator-run AWS probe above covers real uploads. No application service or
database was changed or activated by that probe.

## AWS references

- [POST policy conditions](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-HTTPPOSTConstructPolicy.html)
- [Presigned URL capabilities](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Upload checksums](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)
