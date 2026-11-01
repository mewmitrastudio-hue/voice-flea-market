# Purchase request limits — 2026-11-02 JST

`create-checkout-session`, `cancel-authorization`, and `renew-authorization`
previously read the full request text before checking its character length.
They now stop and cancel the request stream when it exceeds 4,096 bytes,
before authentication lookups, reservations, or provider operations. Missing
and malformed bodies return 400; oversized bodies return 413. Valid requests
retain the existing purchase, bilateral cancellation, and renewal behavior.

Validation: 162 application tests and 14 Apple-verifier tests pass. Five added
cases cover endless multibyte streams, cancellation at the first oversized
chunk, and missing/malformed authorization bodies. Existing tests retain the
normal Checkout, cancellation, renewal, idempotency and account checks.

The deployed versions are create-checkout-session v26,
cancel-authorization v3, and renew-authorization v3. Existing live relative
dependencies and JWT requirements were retained. No schema, credentials,
sales flag, price, real charge, refund, or transfer was changed.

## Remaining release work

The latest candidate remains PR #35 / build 30; public main is a different
revision. The Cloudflare Worker preview build still fails; its detailed log
requires an authenticated Cloudflare session, which was absent in this run.
Do not infer the failure cause from the status badge. Physical-device purchase,
delivery acceptance and refund results, Apple seller funding/settlement and
App Review assets/submission remain unverified. No new iOS build is needed
solely for these server-only request-limit changes.
