# Normal-purchase reconciliation

The old operator dashboard queried the operator's own payment rows through RLS,
limited its totals to 200 rows, and omitted partial refunds. Payment rows did not
identify live/test mode or preserve the Stripe-reported refunded amount.

## Result

- A signature-verified webhook fetches the current PaymentIntent and expanded
  charge before saving a snapshot. It checks mode, JPY amount, successful full
  capture and charge identity. An authorization alone cannot become paid.
- A service-role-only invoker RPC saves mode, charge ID, refunded amount and
  observation time atomically. A slow earlier reconciliation cannot replace a
  later observation. Purchase identity, original paid_at and the existing 15%
  fee calculation stay fixed. Missing purchase rows cause refund-event retries.
- Legacy rows remain unclassified until Stripe reconciliation; no historical
  mode or refund values are guessed or mass-rewritten.
- A moderator-checked RPC reads all operator payment records without widening
  table RLS. Aggregate totals cover the full table, separate Production, Test
  and Unknown, and exclude unverified amounts. Tuple cursors show 10 at a time.
- The dashboard and refund list share that source, include partial refunds,
  retain loaded rows on a paging failure and reject stale account responses.
  Buyer history also shows the environment and Stripe-reported refund amount.

## Limits

These figures are Stripe payment/refund records, not bank deposits, operator
profit, seller transfers or confirmation that the customer's bank posted a
refund. Application-fee refunds and processing costs are not inferred.

This change does not activate live keys, create purchases/refunds/transfers,
change price/fee allocation or replace the current immediate-capture Checkout.
The current delivery acceptance still updates the conversation; receipt-time
capture, authorization-expiry/re-authorization handling and the native normal
voice-purchase flow remain separate unfinished work. Seller finance summaries
retain their prior limited scope and are not a settlement ledger.

## Deployment order

1. Apply `payment_reconciliation` migration (additive nullable columns).
2. Deploy `supabase/functions/stripe-webhook/index.ts`, preserving
   `verify_jwt=false` and Stripe signature verification.
3. Publish the web update. An old client remains compatible with the migration.

## Validation

PGlite runs the actual SQL for 250 mixed records, ownership/write privileges,
full cursor traversal, amount/identity mismatches, refund-before-purchase,
late snapshots and failed-refund reconciliation. Signed handler tests exercise
captured/unpaid/mode-mismatch/refund events and storage failures. UI tests check
pagination retry, escaped titles, partial refunds and account switches.

Sources checked: Stripe separate authorization/capture, expanded charge
reconciliation, Connect refunds, and Supabase RLS/database-function privileges.
