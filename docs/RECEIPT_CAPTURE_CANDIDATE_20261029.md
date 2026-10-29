# Receipt capture and unfinished-trade notices — candidate

This branch is an isolated implementation candidate, not a production release or
proof of physical-device purchases. It builds on the StoreKit proposal in PR #34.
Do not merge or enable sales until the release gates below are complete.

## Implemented in this candidate

- Server-owned, frozen Web Checkout quotes shared by request retries and tabs.
- Manual card authorization, exact JPY amount, recipient and 15% platform fee.
- Signed Checkout reconciliation stores `authorized`, separately from paid money.
- Receipt acceptance is authenticated server-side; clients cannot mark it accepted.
  Capture and a fresh verified destination Transfer precede the database receipt.
- Unknown capture results remain recoverable through the same idempotency key.
- Apple receipts are checked again against the signed authoritative transaction,
  including revocation, before acceptance. No Apple proceeds are invented.
- Both parties approve an undelivered authorization cancellation. Stripe must
  confirm cancellation before the database records completion.
- Reauthorization cancels/verifies the expired attempt before starting a new
  authorization for the original quote. Conversation and delivery remain linked;
  canceled payment attempts are preserved rather than overwritten.
- Home, profile and menu show unfinished trade/settlement tasks with links to the
  relevant conversation or seller finance. Full counts are independent of paging.
  Completed, refunded and canceled trades are excluded; account-switch and failed
  reads cannot expose another user's data or turn an unknown count into zero.

`STRIPE_RECEIPT_CAPTURE_ENABLED` must explicitly be true to create new Web sales.
Existing receipt/refund recovery must remain available when new sales are paused.
No server settings, production data or deployment have been changed for this
candidate. Apply schema and endpoints together with the matching Web/iOS source.

## Remaining release gates

1. Complete endpoint and UI regression coverage for renewal and cancellation,
   verify SDK/runtime compilation, and review concurrency/cancellation edge cases.
2. Validate staged paid recruitment/job orders across Web and iOS against the
   deployed backend. Local SQL and endpoint tests cover frozen accepted offers,
   exact payment/chat association, duplicate prevention, and Apple job receipts.
   Two additional SQL lifecycle tests verify cancellation through both parties'
   deletion eligibility and renewal through delivery acceptance and deletion
   eligibility. Payment history is retained. These tests do not delete real
   accounts, contact Stripe, or establish real-device purchase results.
3. Complete actual Apple proceeds reconciliation and seller settlement evidence;
   actual provider reports must supply net amounts. Keep unconfirmed proceeds
   visibly pending and never estimate a fee rate to authorize payouts.
4. Verify complete/partial refunds, operator recovery, deletion blockers and
   signed webhook configuration against the new authorization lifecycle.
5. Resolve the Worker check failure on the application branch. Production Worker
   deployment and a failed preview check are separate signals.
6. Verify migrations and API privileges against the current schema with a backup,
   then perform controlled Sandbox integration tests with two authorized accounts.
7. Build/sign/distribute the new iOS bundle; verify ordinary purchase and all
   three boost plans on a real iPhone, including cancellation/restart/refund paths.
8. Check App Store product metadata, reviewer credentials, required real-device
   video, selected build, policies, release settings and final review instructions.

App Review submission is conditional on completing these gates. An unsigned
simulator/device compilation is not a signed TestFlight delivery or a purchase.
