# Apple signature verification service

The deployed entrypoint is `signature-only.mjs`. Apple signing private keys and database credentials must never be configured in this service. The Worker holds only the verification-service credential and public Apple app ID. API signing and authoritative transaction lookup stay in Supabase.

The service uses Apple's pinned official SDK with root trust, online OCSP, certificate dates, Apple certificate extensions, app identity and environment checks. Both submitted and authoritative transactions are signature-verified. Transaction ID, environment, product, app-account token and purchase date must match. Errors fail closed. Signed data and credentials must not be logged.

## Confirmed deployment, 2026-10-21

The deployed boost-iap and apple-boost-notifications handlers and their shared adapter match the committed files byte for byte. Supabase to Worker verification succeeded for a genuine Apple TEST notification. Missing service authentication and tampered signatures were rejected. A newly requested Apple Sandbox TEST notification reported delivery SUCCESS. Silver Sandbox entitlement and persistence after app restart were confirmed separately.

These checks do not establish Production API authorization, all plan purchases, or refund/revocation delivery. Production API last returned HTTP401; its cause remains unconfirmed. Do not rotate keys or enable live sales merely to retry this response.

## Release gates

- Retain separate Sandbox and Production transaction environments; never substitute one for the other after an authentication or signature error.
- Recheck Production API authorization using the existing signing configuration before live sales.
- Configure the Production notification URL in App Store Connect and confirm a genuine TEST delivery before launch. This setting has not yet been confirmed.
- Verify Gold and Platinum purchases on separate unboosted test listings. Silver has already been tested; do not repeat it.
- Confirm duplicate notification handling and actual revocation delivery; synthetic tests alone do not establish these live outcomes.
- Keep purchases in Sandbox until release prerequisites are complete. Do not modify credentials, prices, hosting plans or legal agreements as a side effect of this source synchronization.

`index.mjs` and `test/verification.test.mjs` retain the earlier experimental all-in-one design for regression comparison. They are not the deployment entrypoint and require no signing-key bindings in the deployed Worker.

## Validation

Run `npm ci --ignore-scripts --prefix workers/apple-verifier` and `npm test --prefix workers/apple-verifier`. The eleven tests cover credential separation, request authentication, body limits, JWT signature, canonical identity comparison, revocation preservation, Production routing and failure behavior.

References:
- https://github.com/apple/app-store-server-library-node
- https://developer.apple.com/documentation/appstoreserverapi
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
