# Private evidence issuer backpressure

Treat a trusted identity issuer's HTTP 429 as temporary dependency unavailability,
not as a wallet permission failure. Return HTTP 503 with a sanitized Retry-After
(integer 1–300 seconds, default 60) and a generic error. Never expose upstream
body, token, wallet or signed object URL. Preserve no-store and every fresh JWT,
merchant, identity, scope and chain check. Invalid credentials still return 403.

Do not increase issuer limits, cache authorization, sleep inside API requests or
automatically replay prepare (it can reserve metadata). A client should wait for
Retry-After and use a bounded retry policy, reusing the existing evidence ID for
complete/download. Obtain a new token if the current one expires while waiting.
Prepare is not idempotent: reconcile any pending reservation before retrying;
automatic prepare retries are outside this change.

Alternatives rejected: raising limits hides saturation; immediate server retries
amplify load. This change reports backpressure safely but does not increase
throughput or implement SDK retry automation. Other upstream failures retain
their current fail-closed behavior.

Tests cover sanitized headers, no eager retry, invalid credentials, current
revocation after a retry, and saturation during the final download identity
check without releasing a signed URL. QA deployment follows PR review/merge;
real sustained tests remain required before production promotion.
