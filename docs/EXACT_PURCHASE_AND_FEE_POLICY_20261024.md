# Purchase identity and fee policy — 2026-10-24

## Implemented

Checkout already returns its session ID. The client now stores this exact ID
instead of comparing with the latest previous payment. On return, the client
matches session, listing, buyer, paid status, reconciled mode and zero refund.
An account change or a newer pending Checkout stops the old response.

An authenticated, buyer-scoped private function serializes on the payment row
and opens one conversation for that exact payment. A unique index prevents
multiple conversations for the same payment. Insert validation checks both
participants, listing and payment status. The association is immutable.
Existing conversations are not backfilled using timestamps or candidate counts.
Their amounts remain unverified without an explicit payment link.

The approved fee policy is Web seller 85% / platform 15%; iOS seller 85% /
platform 15% of the amount remaining after the actual Apple commission.
The service-only arithmetic returns unknown amounts when Apple fees are
unknown. Platform fee rounds to the nearest yen, matching existing Web
arithmetic; seller gets the remainder, so no yen is created or lost.
This helper is not connected to a native normal purchase, payout or refund.
It does not invent a 15% Apple commission or apply Small Business approval.

## Checks

61 local regression tests pass, including isolated actual SQL and runtime
handlers. Exact session matching, repeated purchases, interleaved opens,
unauthorized users, forged associations, immutable links, refunds, legacy
unverified data, account switches, newer pending purchases, unknown Apple
fees and yen conservation are covered. SQL migration is additive; no legacy
payment values or associations are guessed.

Live verification after migration: original five payment records remain;
zero legacy conversations were backfilled; anonymous RPC execution and
client access to the fee helper are denied. Existing RLS remains enabled.
New two-party purchase-through-delivery on live services is not claimed.

## Mail verified in this session

Welcome self-test received in the operator's actual INBOX. Welcome enabled;
retry scheduler enabled every five minutes after receipt was confirmed.
An operator-notice draft was saved with four eligible recipients, and its
self-test was received only by the operator. Editing content disabled the
send/test controls until the saved draft was reopened. No notice was published
and no announcement email was sent to other users. Confirmation is required
in the UI before a real publication. The test draft is clearly labelled as
unpublished operator verification material.

## Still blocks Apple recording/submission

- iOS ordinary purchases: product catalog, native purchase/verification,
  refund notifications and actual fee/proceeds reconciliation.
- Web receipt-time capture and authorization expiry/re-authorization.
  Existing Checkout still captures immediately. This change does not fix that.
- Recruitment payment integration and actual seller transfers/bank deposits.
- New two-party end-to-end tests, Gold/Platinum/Apple refund device tests.
- Dedicated review accounts, final signed build, review images and recording.

Do not count these fixes as all payment flows complete. No new charge, refund,
transfer, key switch, Apple review submission or general release was performed.
