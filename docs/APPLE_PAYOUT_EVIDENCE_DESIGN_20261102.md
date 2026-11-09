# Apple seller payout evidence — local verifier and server collector

## Scope
`supabase/functions/_shared/apple-payout-evidence.mjs` exports `verifyApplePayoutEvidence`.
No API calls, account configuration, fund movement, database writes, release gates or deletion-guard changes. Not integrated into any live endpoint. Passed fixtures establish local validation behavior, not real bank payment.

The caller must be a trusted server collector. Raw client-supplied JSON is prohibited as evidence. Object fields and collector context are separate: an account ID, request filter, pagination completeness and collection timestamp are NOT invented Stripe object fields. The function cannot authenticate JSON provenance, API credentials, request IDs or metadata by itself.

## Input contract
- `expected`: server-ledger/platform configuration `platformId`, `destination` connected account, `transferId`, `payoutId`, `bankAccountId` from verified external-account configuration, JPY amount, production mode, settlement and payment UUIDs. These are not arbitrary client parameters.
- `transfer`, `destinationPayment`, `payout`, `payoutTransactions`: `{data, context}` envelopes.
- Context: `source: stripe_server_api`, actual request `accountId`, `livemode: true`, `requestId`, `apiVersion`, `retrievedAtMs`.
- List context additionally has exact request `payoutId` and `paginationComplete: true`; collector must aggregate all pages without omission and must not present the final page alone as the entire list. Data requires `object: list`, `has_more: false`.
- Caller explicitly supplies `nowMs` and `maxAgeMs`. No default financial/operational freshness period is invented.

## Read-only collection route (not executed here)
1. Platform GET `/v1/transfers/{tr}`; verify frozen Apple reservation metadata, amount, destination, mode and no reversal. `source_transaction:null` is valid for balance-funded Apple proceeds.
2. Connected-account GET `/v1/charges/{transfer.destination_payment}`, scoped with `Stripe-Account: acct_...`. Match `source_transfer`; obtain its `balance_transaction`. Transfer.balance_transaction is PLATFORM debit, not destination credit.
3. Same connected account GET `/v1/payouts/{po}`. Require standard automatic, reconciliation completed, current paid status, expected bank destination, mode/currency and absence of failure/reversal evidence.
4. Same account GET `/v1/balance_transactions?payout={po}&limit=100` plus all subsequent pages. Match the exact destination credit ID and its source; do not infer membership from dates or equal amounts.

Caller needs authorized platform/connected-account read access for these resources. Restricted-key scopes and account relationship must permit access; insufficient permissions stop collection. An Accounts v2 integration still uses the documented v1 payout resources/events.

## Result / deliberate limitations
`assignmentVerified:true`, `stripePayoutPaid:true` only mean the checked credit belongs to that current Stripe-paid automatic payout. Output includes credit gross, fee and net separately, plus total payout amount. It never assigns a share of the bank deposit or claims the gross seller promise was received.

Payout totals can differ from a single credit (other credits, debits and fees). No fee-bearing business policy or allocation formula is inferred. `bankReceipt:'unverified'`, `bankReceiptVerified:false`, `settlementComplete:false` are fixed invariants.

Reject manual/instant/not-applicable/in-progress, missing pages, stale/unknown/wrong account context, mode/currency/source/destination mismatch, credit refund/dispute, partial/full transfer reversal, payout failure/cancellation/reversal, duplicate rows and invalid credit arithmetic. Future paid→failed changes require fresh evidence; no permanent finality is claimed.

Actual bank receipt needs separately authorized bank-side evidence/reconciliation. Partial refunds and financial finalization require independent report-backed policy and evidence. This verifier does not resolve them.

## Official sources consulted 2026-11-02
- https://docs.stripe.com/api/transfers/object
- https://docs.stripe.com/api/charges/object
- https://docs.stripe.com/api/payouts/object
- https://docs.stripe.com/api/balance_transactions/list
- https://docs.stripe.com/api/balance_transactions/object
- https://docs.stripe.com/api/transfer_reversals/object
- https://docs.stripe.com/payouts/reconciliation
- https://docs.stripe.com/connect/authentication
- https://support.stripe.com/questions/how-does-a-platform-set-the-description-or-metadata-on-the-payment-in-a-connected-account?locale=en-GB

Stripe docs skill read; Stripe CLI unavailable. Used official Stripe documentation search connector, then official API pages to verify exact field definitions. No live financial API action performed.

## Local validation
`node --test tests/apple-payout-evidence.test.mjs`: 38 passed, 0 failed. Tests include aggregate amount differing in both directions, explicit fees/net, wrong provenance/account/freshness, missing membership/pages, cancellation/refund/reversal and fixed non-finality outputs. Log: `/tmp/apple-payout-evidence.log`.

## Authorized local integration (2026-11-02, subsequent checkpoint)
`apple-payout-collector.mjs` now fetches evidence through read-only Stripe SDK calls, verifies external-account path ownership and the configured platform identity, preserves per-page response context, and re-fetches transfer/charge/payout after pagination. API permission errors and incomplete pages stop without permission expansion. Six dedicated mocked-API tests pass. No real Stripe calls were made.

The new operator-only `apple-financial-resolution` endpoint uses this collector, fresh Apple evidence, a stored preview and separate explicit bank-original confirmation. Its private audit ledger may mark only an eligible zero-fee/non-refund obligation bank-reconciled. The pure verifier itself still never claims bank receipt or final settlement. See FINANCIAL_RELEASE_GATES_20261102.md for deployment, real-evidence and liability gates.

### Full-batch non-loss predicate
The verifier now also returns `batchAllPositiveNoFees`, `batchNetTotalJpy` and `batchMatchesPayout`. Complete per-row safe-integer arithmetic and BigInt aggregation prevent overflow. The assignment-only result remains available for mixed fee/debit batches, but the separate operator finalization path requires all available positive zero-fee credits and a total exactly matching the bank payout. Seven new cases cover mixed debit, another credit's fee, missing arithmetic, pending entry, aggregate overflow and unexplained lower payout. This does not guess who bears shared deductions.
