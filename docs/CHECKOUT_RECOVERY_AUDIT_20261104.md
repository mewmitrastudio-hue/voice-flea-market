# Web checkout recovery audit — 2026-11-04 UTC

Source-only change based on candidate36 (`3c2a0b2`). The parent integration owns the next release/build label. No backend, sales flags, StoreKit journal, native purchase operation, or payment timeout was changed. No push, deployment, charge, refund or Apple submission was performed.

## Reproduced and fixed

- Recovery of a completed Stripe Checkout left the purchase button disabled and labelled as preparing. Button state now resets on every settled preparation outcome, including a successfully recovered transaction and the page retained for browser Back.
- When a completed Checkout was not yet reconciled, the generic error dialog replaced its “do not repurchase” warning with retry advice. That recovery outcome now has an explicit status and safe instructions; its exact session/attempt remains available.
- A delayed Checkout response could redirect the user after they navigated elsewhere, including away and back to the same page. A navigation revision prevents that stale redirect. Authentication that resolves after navigation no longer starts an abandoned request. A late response still preserves the exact reservation for recovery.
- A departed account's response could show its error on the replacement account screen. Stale error UI is now suppressed.
- Completed exact-session reconciliation continues after navigation and still requires matching buyer, target, payment and verified evidence. It may clear only that verified pending session, while suppressing stale success UI. It never treats navigation as payment cancellation.

## Local checks

The actual application functions run in deterministic VM tests with mocked network/native boundaries. Twelve new checkout tests cover listing/job identity, repeated taps, completed and unresolved recovery, navigation during authentication/response, away-and-back, replacement accounts, retries, trusted redirect URLs and reusable button state. Two new exact-payment tests cover completion before/during navigation. Eight of the original nine focused cases failed against the unmodified source, then all passed after the fix.

- Focused checkout/menu/navigation/native-release/boost/cross-kind suite: 63 passed, 0 failed.
- Exact-payment UI subset: 3 passed, 0 failed (includes the existing isolation test).
- Apple voice purchase/recovery UI subset: 10 passed, 0 failed, retaining repeated-tap, cancellation, pending journal, failed verification and close/reopen coverage.
- `npm run build`, `CI_BUILD_NUMBER=36 npm run capawesome:build`, `npm run ios:verify`, inline JavaScript/hash validation and `git diff --check`: passed. The generated project build-number change was restored; parent integration owns the release increment.
- Web SHA256: `6e7ce87ea801adb1bb78913d89bae6e4e728a9af8e95e5815f4675b1460c0b59`. Native SHA256 unchanged: `259971ce55b32bdb49946b86e66f450dc73ce7a59bb1425935165603121eee21`.

The full sequential `npm test` run was attempted but is **not a passing aggregate**: 309 tests passed; 17 database-heavy test-file subprocesses terminated rather than returning assertions. A direct TAP rerun of `exact-purchase.test.mjs` reports `SIGKILL`; the other failed files report process-level failure. The cause was not established. Expected full-suite count after the 14 additions is 393 when all files execute normally.

Affected files: `apple-financial-report`, `apple-financial-resolution-db`, `apple-proceeds-ledger`, `apple-refund-review-hold`, `apple-settlement-db`, `boost-price`, `boost-ranking`, `buyer-seller-audit`, `exact-purchase`, `job-purchase`, `job-terminal-lifecycle`, `payment-reconciliation`, `pending-trades`, `purchase-channel-lock`, `receipt-authority`, `terminal-trade`, `voice-iap` (all `.test.mjs`). The parent retains the complete run log and must rerun the aggregate before a release claim.

These tests do not prove physical-browser Back/Forward caching, real Stripe/Apple checkout, Swift compilation, signed distribution, latest-OS device recording, or App Review readiness. Those gates remain separate.
