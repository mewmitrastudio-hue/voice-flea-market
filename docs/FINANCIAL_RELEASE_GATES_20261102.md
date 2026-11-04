# Financial release gates — isolated local candidate, 2026-11-02

This file describes work after PR35 head `438079fa50b9043d9ea87494a9400035b69f19cd`. Nothing here establishes a live deployment, successful production transfer, actual bank receipt, or Apple review readiness.

## A. Completed locally: unsupported Apple refund evidence fails closed

### Defect and repair
Apple now represents prorated refunds with `revocationType=REFUND_PRORATED` and `revocationPercentage` in milliunits. The old signature Worker dropped both fields, and the shared Edge dispatcher converted any revocationDate into the existing full-refund boolean RPC. That could misstate a partial buyer refund and enable an excessive seller recovery.

The Worker now preserves these fields and marks the preserved evidence version. The dispatcher rejects unsupported, malformed, contradictory or old-worker revocation evidence before invoking a full-refund RPC. Explicit full refunds and versioned legacy full-refund records retain their previous path. Unknown evidence is not converted to a guessed yen value.

For a verified ordinary voice refund requiring review, the dispatcher durably records a hold before returning an error. The local migration was generated with the official Supabase CLI 3.0.0, `migration new apple_refund_review_holds`, with an isolated writable CLI HOME and npm cache; no hosted project was linked or migrated.

### Durable hold behavior
- Private RLS-protected hold ledger, service-only record RPC, bound to order/transaction/environment/price/actor. First evidence is retained; repeated receipt processing does not create a second hold.
- No client clear endpoint. No refund amount, fee split, paid amount or bank state is fabricated.
- Held purchases fail verified-payment and verified-refund checks. Delivery/acceptance, new allocation, new settlement dispatch and full-refund recovery are blocked by existing guards or new DB triggers.
- A hold before initial payment prevents subsequent normal fulfillment. Only the order's buyer/seller are subject to the hold; unrelated users are unaffected.
- Previously dispatched transfers may already be in flight: their actual evidence can still be reconciled. A hold does not reverse or pretend to cancel them.
- `apple_refund_review_status()` is read-only and returns `{reviewRequired,count}` scoped to the authenticated participant. UI must not display an RPC failure as “no hold”.
- User-facing Edge errors distinguish a committed hold from unresolved evidence. Notification processing returns failure for retry rather than acknowledging unhandled refunds.

### Deployment dependency (not performed)
Migration and Worker/Edge rollout must be coordinated. Deploy the additive hold migration before relying on hold persistence. A new Edge seeing an old Worker rejects revoked evidence rather than guessing. Worker preservation plus all users of shared `apple.ts` must be included: `voice-iap`, `boost-iap`, `apple-boost-notifications`, `accept-delivery`, `apple-settlement`. Re-fetch live deployed sources and verify permissions/advisors after authorized deployment. Partial refunds remain unprocessed review items, not completed settlements.

## B. Implemented locally: report-backed operator adjustment facts (not money recovery)

The user approved an evidence-first manual workflow on 2026-11-02. The new private audit ledger and `apple-financial-resolution` operator endpoint record a single-unit JPY Apple return row, exact customer refund and actual Apple net debit, with a report-row uniqueness guard and explicit operator association note. Preview, confirmation and approval use a durable operation UUID and summary hash. The report is the existing server-stored report snapshot, not client-provided monetary fields.

Approval records facts only. It keeps the refund review hold and adjustment-required allocation; it does not issue a second buyer refund, recover seller funds, or invent fee/rounding/shortfall allocation. Multi-unit aggregate return rows are rejected by this narrow workflow. Their allocation and any unresolved liability require a separately approved specification and actual reports.

## C. Implemented locally: audited bank-receipt approval and narrow terminal settlement

The server fetches the exact production transfer, connected destination credit, external bank-account ownership, automatic payout and all paginated payout transactions using read-only Stripe API calls. It re-fetches current Apple transaction evidence and rejects revoked evidence. Fresh server observations are stored separately from stable preview hashes, including API request/account/time context. Raw bank statement contents remain on the operator device; its SHA256, reference/date/full payout amount and operator attestation are recorded privately.

Only a normal paid, unrefunded, no-hold, zero-credit-fee order with the complete seller amount attributed to the payout can become bank-reconciled after explicit bank-original confirmation. Stripe `paid` alone is never bank receipt. The entire payout batch must consist of available positive credits with zero fees, valid integer arithmetic, and a total exactly matching the payout. Mixed debits/fees, unexplained totals, unknown fees, negative balances, partial refunds or shortfalls remain held. Approval never creates a transfer, refund or debit.

Late Apple refunds, review holds, transfer reversals and authenticated connected payout failure/cancellation evidence reopen the terminal obligation without erasing the audit. A separate `apple-payout-notifications` webhook verifies the signature and exact connected-account scope, re-fetches the failed/canceled payout, then invalidates related records only. Its deployment and actual event subscription remain external release gates.

Deletion remains blocked by unresolved obligations. A completion-time transactional recheck prevents a previously prepared deletion from treating its old preflight as financial completion. The delete-account Edge handler now validates the file plan and completes that database check before removing public samples/avatars; a refusal performs no Storage, sign-out or Auth deletion. Financial records and account identifiers are retained; this is not permission to purge a review account.

## Deployment and evidence gates for B/C
- Apply both additive migrations in order, deploy the new operator endpoint and payout notification endpoint and updated delete-account endpoint, and coordinate Worker/shared-Edge rollout. No deployment performed.
- Confirm configured admin UID is a current server-side moderator; existing service-role execution is required. No client grants to private tables.
- Confirm existing production platform identity and authorized connected-account read permissions. Permission failure stops; no access expansion is attempted.
- Configure and verify the dedicated signed connected payout webhook and event delivery. No webhook created here.
- Obtain actual Apple reports and original bank statements, then perform real operator reconciliation. Mock fixtures are not proof of payment.
- Additional fee/rounding/shortfall responsibility and aggregate-return mapping remain separate decisions. Uncertain cases stay held.

## D. Not implemented: ambiguous StoreKit reservation terminal resolution

**Exact gap:** server Apple prepared reservations and device journals deliberately survive empty unfinished lists and elapsed time; there is no authoritative cancellation evidence flow to clear every ambiguous case. Apple pending/Ask to Buy absence is not proof of cancellation. The parent workstream is assessing current Apple-supported evidence paths.

**Do not implement:** timeout deletion, client-asserted “cancelled” as server proof, automatic cross-channel repayment, account deletion to discard purchase obligations.

## Official references checked
- Apple refund types: https://developer.apple.com/documentation/appstoreserverapi/revocationtype
- Apple refund percentages: https://developer.apple.com/documentation/appstoreserverapi/revocationpercentage
- Apple StoreKit pending: https://developer.apple.com/documentation/storekit/product/purchaseresult/pending
- Stripe payout reconciliation and automatic payout attribution: https://docs.stripe.com/payouts/reconciliation
- Stripe bank reconciliation (paid vs bank-reconciled): https://docs.stripe.com/bank-reconciliation
- Stripe connected-account balances/liability: https://docs.stripe.com/connect/account-balances

## Release status
Local safety tests are necessary but not sufficient. This candidate still needs unresolved refund-liability policy and real financial evidence, authorized environment rollout, external funding/connected-account access and evidence, full seller/buyer end-to-end tests, and iPhone/Apple review checks. Do not call the marketplace sell-ready or “only recording remains”.
