# Apple signature verification service — deployment proposal

Not deployed or connected to the application. The deployable entrypoint is
`signature-only.mjs`. Apple signing private keys and database credentials must
never be configured in this service.

The service uses Apple's pinned official SDK with root trust, online OCSP,
certificate dates, Apple certificate extensions, app identity and environment
checks. It requires a dedicated service credential. It handles signed data only,
does not persist purchase information, and does not log payloads or identifiers.

The proposed `supabase-adapter.mjs` keeps Apple API signing and authoritative
transaction lookup upstream. Both the submitted transaction and the latest
Apple response are signature-verified; identity, product, account token,
environment and purchase date must match. API and verification errors fail closed.
The adapter is not yet wired into deployed Edge Functions.

Local unit tests pass. A genuine Apple TEST notification passes in local workerd
with real online OCSP through a Node transport bridge; missing authentication and
a tampered signature are rejected. This does not establish hosted deployment
success. A hosted genuine TEST delivery and purchase/revocation end-to-end test
are mandatory before enabling sales.

Deployment gates:
- Confirm the correct hosting account and authorized processing destination.
- Set only APPLE_APP_ID (non-secret) and APPLE_VERIFIER_SHARED_SECRET (encrypted).
- Obtain authorization for new service access and processing of signed purchase data.
- Do not accept new legal terms or add paid plans without confirmation.
- Verify hosted TEST delivery before changing existing production receivers.

`index.mjs` and `test/verification.test.mjs` retain the earlier experimental
all-in-one design for comparison; they are not the deployment entrypoint.
Never configure its Apple signing-key bindings in the signature-only service.

References:
- https://github.com/apple/app-store-server-library-node
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
