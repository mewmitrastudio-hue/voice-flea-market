# Buyer and seller audit — 2026-10-24

## Corrections

- Listing prices now match the existing Checkout minimum of JPY 50, both in
  the form and database. Titles and delivery dates are checked before upload.
- Seller totals use an owner-scoped invoker aggregate across the full table.
  Only reconciled live payments without refunds contribute to the displayed
  original seller allocation. Test, unknown and refund records are explicitly
  excluded; the figure is not a bank balance or receipt-time settlement.
- Failed buyer-history pagination preserves loaded records and retries the
  same range instead of replacing the entire history with an error.
- A conversation with several candidate purchases no longer displays the
  latest unrelated payment date/amount. Current listing prices are not used
  as historical paid prices. Recruitment budgets are labelled as budgets.
- Closing a chat removes its chat-specific hide button from the list view.
- Native iOS normal purchases explicitly remain unavailable until their
  implementation is ready; they no longer open an external Stripe Checkout.
  Existing purchased conversations remain accessible. Web Checkout is unchanged.

## Automated checks

Tests execute the existing deployed Checkout, refund and account-deletion
handlers with local dependencies, without real service credentials or network
requests. They check seller/buyer identity, server-derived amounts and fees,
self-purchase rejection, recipient readiness/mode, uncertain Checkout outcomes,
refund authority/amount/mode/idempotency, and deletion balance safeguards.
PGlite executes the seller aggregate against 1,200 payments and distinct roles.
UI tests cover rejected prices/dates, history retries and repeat purchases.

The server handler checks ran locally against retrieved runtime code. Internal
Checkout/refund/deletion implementations are not included in this public change.
Those checks do not activate a new payment flow.

## Live UI checks

Authenticated as the user's operator account: dashboard and refund list load
all five legacy payment records as unclassified; no live amount is invented.
The user's Silver Sandbox boost agrees with the operator's record and expiry,
and active boosts disable repeat purchase. No Silver repurchase was requested.
Search/no-result, own-listing exclusion, budget filter, sort control,
favorite add/remove, blank listing/job/report validation, block confirmation
and cancellation, completed chat history and private delivery playback were
inspected. The test favorite was removed; no messages/reports were sent and
no user was blocked. The five-second delivery played with no media error.
An unsent draft persisted across closing/reopening the chat and was cleared
after testing. Opening the conversation cleared the unread count to zero.

## Incomplete work — recording/re-submission is not ready

1. iOS normal-voice purchase flow and Apple fee allocation remain undecided.
   Existing Checkout still captures immediately; acceptance updates the
   conversation rather than capturing/releasing a payment.
2. Transactions need an immutable payment-to-conversation link. Legacy repeat
   purchases cannot safely be matched by taking the latest payment. The UI
   now exposes this limitation; it does not resolve that accounting relation.
3. Recruitment/application acceptance has no integrated payment flow. A budget
   or accepted application must not be represented as payment confirmation.
4. New two-party purchase/delivery/acceptance/refund testing is pending. The
   logged-in account is the seller of every active listing and has no buyer
   purchase history. Existing records are not new end-to-end tests.
5. Gold/Platinum StoreKit purchases and real Apple refund-notification testing
   need the iPhone app; this web browser cannot run StoreKit.
6. Legacy payment modes/refund amounts, actual transfers, processing costs and
   bank deposits are not reconciled. Seller allocation is not actual payout.
7. The App Store review account, final signed build and real review screenshots
   and recordings remain pending. Small Business enrollment was received by
   Apple; approval/effective date is not confirmed. JCB review remains pending.

An attempted live unauthenticated POST audit of payment/refund/deletion
endpoints was rejected by automatic approval review because of possible
production side effects. It was not retried; the corresponding handlers were
tested locally. Do not report those production requests as verified.

Private media remains in a private deliveries bucket and all 15 public tables
have RLS enabled. Existing security advisories remain tracked separately.
Reading policies and guards is not equivalent to a complete penetration test.
