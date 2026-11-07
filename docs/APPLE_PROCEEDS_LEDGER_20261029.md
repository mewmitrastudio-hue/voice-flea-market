# Apple proceeds allocation ledger — 2026-10-29

The additive `20261029033154_apple_proceeds_allocation_ledger.sql` migration
is deployed. No actual report, allocation or transfer was created.

An operator can now explicitly associate a Japanese JPY voice-sale report row
with the exact IDs of completed, verified Production payments. The report
quantity must match the selected payment count; product, price, environment,
transaction identity, participants, refund state and completed delivery are
checked on the server. The operator records a reconciliation note and the
record retains the source report, selected IDs, actor and time. Report rows
are aggregate evidence, so this is an operator allocation, not an Apple-signed
transaction-to-financial-row mapping. The system does not infer membership
from date or amount. Other currencies, countries, return rows, boosts and
unfinished trades cannot use this allocation path.

Whole yen of the actual reported proceeds are allocated deterministically in
payment-ID order. Sub-yen proceeds remain a documented fractional carry.
Platform fee is 15% rounded to a whole yen per payment; seller receives the
remainder. Net proceeds equal platform fee plus seller liability exactly.
Replaying the same row and payment set does not create another liability.
Different selections for an allocated row are rejected. A subsequent refund
flags its existing allocation for adjustment and excludes it from the unpaid
seller total; audit evidence remains. Refund adjustments are not automatically
paid, recovered or allocated against other transactions.

The operator UI includes report-row selection, explicit payment selection,
reconciliation notes and a confirmation checkbox. Stale account responses
are discarded, repeated taps share one in-flight save, and direct table access
is denied to clients. The public RPC wrappers use invoker security; private
functions independently enforce operator or seller identity.

## Deployment and limits

The new tables and RPCs are live. The new operator UI is source-only; it is
not in public Web main or installed build 28. Build creation and distribution
remain stopped by the user's instruction. The candidate manifest identifies
release 2026.10.29-5 with a minimum future build of 29, to prevent old binaries
being confused with this source. No build 29 has been created or uploaded.

Live verification: allocation batches 0, allocations 0, Apple payments 0;
anonymous allocation execution and direct authenticated table reads denied.
The prior security warning categories/counts are unchanged. The three new
private tables use RLS with no client policies intentionally.

Stripe's official top-up documentation supports non-Stripe income and lists
Japan as generally available. It requires an approved platform profile and
fund availability. This account's top-up approval and the actual funding path
have not been verified. No funding, transfer or bank receipt is implied by an
allocation. Transfer creation, transfer verification, payout/bank evidence,
refund recovery and release of settlement-related account deletion still
remain incomplete. This migration alone is not settlement completion or
launch approval.

Reference checked:
https://docs.stripe.com/connect/top-ups

Validation executed the actual SQL on isolated Postgres-compatible databases
and the actual UI functions with controlled service responses. It covered
fractional proceeds, 85/15 conservation, replays, identity/environment/refund
failures, permissions, seller isolation, refund-after-allocation, repeated
taps and account switching. These are not bank or StoreKit device tests.
