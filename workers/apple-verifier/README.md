# Apple verification service — experimental proposal

Not deployed or connected to the application. Do not merge or deploy without integration verification.

This proposal separates Apple signature verification from database updates, using the official Apple SDK with root trust, online OCSP, environment and authoritative transaction checks. It does not require database credentials and does not enable purchases.

Six local unit tests cover request authentication, input validation, verified notification acknowledgment, environment routing, signature failures and authoritative transaction mismatches. Unit tests do not establish hosted runtime compatibility.

Deployment requires a successful genuine TEST notification, rejected tampered signatures, validated server API authentication, environment isolation and end-to-end purchase/revocation checks. Store secrets only in encrypted runtime configuration. Never commit private keys, environment files or service credentials. A new hosting destination for secrets requires authorization.

Official references:
- https://github.com/apple/app-store-server-library-node
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
