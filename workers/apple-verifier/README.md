# Apple verification service — deployment proposal

Status: **not deployed, not connected to the application**.

The existing Supabase Edge Runtime fails on the Node X509Certificate operations
used by Apple's official verifier. The observed exceptions are
`crypto.X509Certificate.prototype.toString` and `.raw` (both not implemented).
The same genuine Apple Sandbox TEST notification passed signature verification
with the official SDK under Node 24.19.0 and online OCSP enabled.

This separate verification service retains the official Apple SDK, root trust,
online OCSP, bundle/app identifiers, environment checks and authoritative
transaction lookup. Database updates remain in Supabase. The service never needs
a Supabase database or service-role key. It does not enable purchases.

Six Node tests cover authentication, malformed/oversized input, acknowledgment
only after verification, environment routing, rejection of invalid signatures,
and mismatched authoritative transactions.

## Deployment gates

- Local workerd/Miniflare can now initialize the SDK and dispatch requests after
  deferring the SDK import and adapting its node-fetch transport. The genuine
  TEST payload still returned HTTP 503: outbound Apple OCSP requests received
  HTTP 403. This is an observed local test result; its root cause and deployed
  Workers behavior are not established. **No Workers integration pass is claimed.**
- Confirm that the selected hosting runtime supports the official verifier,
  including X509 methods, OCSP and signing API requests. A passing Node test is
  not proof of a passing Workers deployment.
- Obtain explicit authorization before storing the Apple private key at a new
  hosting destination and creating shared service credentials. Existing approval
  covers Apple key generation and Supabase registration only.
- Do not change paid hosting plans or accept new legal terms automatically.
- Set encrypted service secrets; do not commit .dev.vars, .env or .p8 files.
- Run genuine TEST delivery, invalid-signature rejection and API authentication
  checks on the intended hosted runtime before connecting Supabase to it.
- Connect both Edge Functions only after successful integration testing and
  approval of the exact production change. Do not work around the automatic
  review rejection recorded below.

## Existing production status on 2026-10-21

- App Store version 1.0 build 19 is selected and saved; state is preparation.
- Apple key `9D3AKFA2BU` was downloaded, checked, registered in Supabase, and its
  saved digest matched the file. Older active key was not revoked.
- Sandbox notification history API: HTTP 200. Production history API: HTTP 401;
  cause not established. Do not claim production authentication passes.
- Genuine TEST delivery to the existing Edge receiver: unsuccessful; replay 503.
- Existing receiver version 7 contains bounded failure diagnostics and a PEM
  compatibility attempt; it still fails because X509Certificate.raw is missing.
- An attempt to restore the original receiver configuration was rejected by
  automatic approval review because that configuration retains a known payment
  verification failure. No indirect retry was performed.
- BOOST_IAP_ENABLED remains false. No paid purchase, App Review resubmission or
  public release was performed.

## Other release blockers

- Resolve the ordinary audio purchase/payment model under Apple's Japan rules;
  Stripe alone must not be declared compliant for in-app digital audio.
- Review/test accounts, latest physical-device video, IAP review screenshots and
  device coverage need actual verification.
- Sandbox purchase, persistence, duplicate delivery, revocation and environment
  isolation need end-to-end evidence before enabling sales.

Official references checked 2026-10-21:
- https://github.com/apple/app-store-server-library-node
- https://developer.apple.com/jp/support/payment-options-on-the-app-store-in-japan/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
