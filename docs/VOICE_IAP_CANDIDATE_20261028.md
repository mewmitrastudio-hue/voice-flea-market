# Ordinary voice StoreKit purchase candidate — build 26

This branch is a tested implementation candidate, **not a launched payment
service, signed/TestFlight build, submitted version or App Store approval**.
No production schema, Edge function, verifier deployment or sales flag has been
changed by preparing this branch.

## Implemented

- iOS ordinary purchase routes to StoreKit, never to external Stripe Checkout.
- An explicit confirmation displays Apple's localized price; JavaScript and
  Swift require JPY and an exact match to the server's immutable order price.
- Server-owned catalogue, buyer/listing/product/price/environment-bound UUID
  orders; self-purchases, blocked/deleting accounts and stale listings denied.
- Apple signature verification plus authoritative App Store Server API lookup.
  The signed price is in **milliunits**, not yen. Quantity must be one.
- One order/transaction/payment/conversation association, replay protection,
  idempotent receipt retries, buyer ownership checks and refund monotonicity.
- Pending purchased transactions can be reconciled after new sales are disabled.
  StoreKit finishes only after successful durable server reconciliation.
- Notifications route boost and ordinary receipts separately. An authenticated
  boost verification request cannot accidentally use the voice notification path.
- Apple and Stripe evidence remain separate. Apple commission and seller net
  proceeds are null until known; no invented 15% Apple fee or payout balance.
- Test purchases are identified in payment history and trade details. Refunded
  purchases retain history but cannot continue delivery or acceptance.
- Private tables use RLS; service-only receipt/order RPCs are denied to clients.

## Validation

- Root Node suite: 67 passing tests at candidate verification.
- Apple verifier suite: 13 passing tests, including the actual deployed adapter.
- `CI_BUILD_NUMBER=26 npm run capawesome:build` bundles identical current HTML,
  prepares the native plugin and verifies source hashes/build number locally.
- GitHub pull-request workflow compiles simulator and unsigned device builds.
  **Unsigned compilation is not distribution or a device purchase test.**

## Launch gates still open

1. App Store Connect session could not be established: the observed login page
   returned `authResult=FAILED`. Current app review status is unknown. No new
   identity-verification requirement is inferred from this.
2. Create and verify the consumable `com.ayuhide.koenofurima.voice.jpy1000` at
   JPY 1,000 in App Store Connect. It matches the current active listing prices;
   **arbitrary other listing prices are not automatically purchasable on iOS**.
   Do not enable an unconfigured product or round a seller's price to another tier.
   Confirm storefront availability before extending beyond JPY.
3. Review/apply the additive migration only after snapshotting current schema,
   role/grant/trigger definitions and checking advisors. The branch fixture
   captures production trade authority guards, but is not a full DB backup.
4. Deploy the updated signature-only verifier and shared Edge adapter plus
   `voice-iap`, `boost-iap`, and `apple-boost-notifications` coherently. Preserve
   existing credentials. No signing key belongs in the verifier or client.
5. Set `VOICE_IAP_ENVIRONMENT=Sandbox`, `VOICE_IAP_ENABLED=true` for controlled
   Sandbox testing and enable the Sandbox catalogue entry. Production remains
   off. `BOOST_IAP_ENABLED` is independent and remains unchanged.
6. Use two authorized test accounts to exercise new purchase, cancellation,
   Ask to Buy/pending approval, lost-response recovery, app restart/account
   switch, delivery, buyer acceptance and Apple refund. Test all three boosts.
   Check StoreKit interrupted/repeated requests on an actual device. Automated
   mocks do not establish these device results. Do not use live charges as tests.
7. Implement and verify actual seller settlement and cancellation/refund ledger.
   Existing Web Checkout captures and uses a destination charge immediately;
   **authorization → delivery/acceptance → capture/transfer is not implemented
   by this branch**. Recruitment acceptance also lacks integrated payment.
   Existing finance totals do not establish available bank payout funds.
8. Apple proceeds/commission reporting must be reconciled before releasing an
   iOS seller payout. The approved split is 85/15 **after actual Apple fees**;
   Sandbox or unknown proceeds must never authorize a payout.
9. Create a signed build 26 or later, upload to TestFlight and record the actual
   build. Complete review credentials, privacy answers, screenshots, metadata,
   moderation/deletion verification and review notes for the final binary.
   Do not submit a version containing purchase placeholders as sales-ready.

## Deployment safety

Both catalogue flags default to false; `VOICE_IAP_ENABLED` defaults to off.
Receipts remain reconcilable when new sales are off. Existing Web rows retain
their channel and are never relabelled as Apple payments. No historic payment
or conversation is backfilled by guessing. Review reports/refund automation
and seller summaries against the new channel before rollout. Do not enable
production until settlement and the actual purchase/refund tests pass.
