# Manual financial resolution workflow — local candidate

Policy approval supplied on 2026-11-02: match partial refunds against actual Apple financial reports and obtain explicit operator approval; never recover unknown amounts automatically. Seller settlement requires bank-receipt reconciliation, not a transfer status alone. Additional-fee and recovery-shortfall liability stays on hold pending a separate decision.

## Implemented locally

Migration `20261102142155_apple_financial_resolution_audit.sql` was generated using official Supabase CLI 3.0.0. It adds private, RLS-protected financial reviews, exact report-return associations, operator bank receipts, terminal obligations, immutable server observations and audit events. No deployment or financial operation was performed.

### Partial refund facts

The operator selects a Production payment and an imported Apple report's single-unit JPY return row, checks the original source, previews the exact customer refund and Apple net debit, then explicitly approves. Amounts are derived from the server-stored report, not client amount fields. Multi-unit/foreign-currency/mismatched rows are rejected. Report-row reuse and operation-ID substitution are rejected. Approval stores facts and retains an unresolved financial hold; it does not decide fee/rounding/shortfall policy, invoke recovery or release obligations.

### Bank reconciliation

The server re-verifies the current Production Apple transaction, then uses read-only Stripe API calls to collect the exact platform transfer, connected destination payment, bank-account ownership, automatic payout and every payout balance-transaction page. The final transfer/credit/payout are retrieved again. Operator confirmation separately attests that the original bank statement matches its local SHA256, bank reference, receipt date and the **whole payout** amount. This is an operator-attested bank receipt, not an automatic bank API certification.

Only ordinary unrefunded/no-hold sales can reach terminal settlement, and only when the complete seller credit is represented, there are no credit fees, the entire payout batch consists of positive available zero-fee credits, and its exact total matches the payout and bank receipt. Mixed debit/fee batches, unknown totals, partial refunds or shortfalls remain held. Even successful approval creates no transfer, refund, reversal or bank debit.

Private observations retain sanitized server responses and their request/account/time/page context plus a SHA256, separately for preview and approval. Their changing timestamps do not affect the stable preview hash. Client-provided observations are ignored. Originals, routing/account numbers and bank-statement file contents are not uploaded by the UI.

### Late evidence and deletion

Late Apple refunds, new review holds, transfer reversals and allocation adjustments reopen a terminal obligation, retaining its earlier evidence. The dedicated signed connected-account webhook freshly retrieves failed/canceled payouts before invalidation. A durable failure tombstone is recorded **even before a bank receipt exists**. Approval and webhook use the same payout-identity advisory lock before payment locks: an early failure prevents stale approval, a later failure reopens it. Event IDs are idempotent and cannot be reassigned across payout/account identities.

A `BEFORE UPDATE completed_at` trigger rechecks financial obligations when finishing account deletion, locking the user's orders and payments. A late hold after deletion preparation raises an error so earlier profile anonymization in the same transaction rolls back. Already-completed deletions are not reversed by late evidence: financial records and obligations remain retained; collection/shortfall resolution is not automated.

## Endpoint contract

`POST /functions/v1/apple-financial-resolution`, user JWT. The configured administrator AND database moderator check must pass. Direct database review/approval RPCs are service-role only.

- `previewAdjustment`: `{operationId,paymentId,reportId,lineNumber,note}`
- `previewBankReceipt`: `{operationId,paymentId,payoutId,bankAccountId,bankStatementSha256,bankReference,receivedDate,receivedAmountJpy,note}`
- `approve`: `{operationId,previewHash,confirmation:true}` — fresh evidence is checked again.
- `status`: `{operationId}` — use the same ID after an unknown response.

Response: `{operationId,kind,state,previewHash,summary,settlementComplete,reviewRequired}`. `kind` is `adjustment` or `bank`; `state` is `preview`, `approved` or `invalidated`. Bank approval exposes `summary.operatorBankReceiptApproved=true`, not a claim of automated bank verification. Approved report facts and mixed-batch receipts still return `settlementComplete=false, reviewRequired=true`. Changed fresh evidence invalidates the preview. Explicit 404 `operation_not_found` permits retrying the same operation ID/input; never assume a timeout means nothing was saved.

## Deployment gates — not performed

1. Apply refund-hold migration before financial-resolution migration; verify the existing `account_deletions.completed_at` column and all referenced live schema objects. Run security advisors and inspect grants/RLS. No client release endpoint exists.
2. Deploy preserved Apple refund fields in the signature Worker and all shared-Apple Edge users together. Old Worker revoked evidence is safely rejected.
3. Deploy `apple-financial-resolution` with JWT verification enabled, correct ADMIN_USER_ID, service credentials, existing Production Apple verifier and restricted Stripe read access. Do not enable money movement to test it.
4. Deploy `apple-payout-notifications` with `verify_jwt=false` **only because Stripe signature validation is mandatory**. Configure dedicated `APPLE_PAYOUT_WEBHOOK_SECRET` and signed connected-account `payout.failed` / `payout.canceled` events; verify actual event delivery. No webhook was registered or modified here.
5. Test approved accounts with real permitted Sandbox/production-read evidence. Mock/pure/PGlite success does not establish actual bank receipt, live payout permission, funding approval or iPhone success.
6. Multi-unit return assignment, fee/non-returned-fee policy, fractional refund allocation, recovery shortfalls, invalidated-payout replacement and ambiguous StoreKit cancellation remain review paths—not guessed automatic resolutions.

## Local test scope

PGlite executes actual schema/functions and tests normal bank completion/idempotency, source-row reuse, mismatch and role rejection, extra-fee/mixed-batch holds, later Apple/payout failures, early failure tombstones, private audit bindings/hashes, and deletion preparation→late refund→completion rollback. Edge VM tests execute actual handler code with controlled external services and cover bank/adjustment wiring, forged client evidence exclusion, Sandbox rejection, collector failure, changed-preview invalidation and actionable states. Payout handler tests reject unsigned/oversized requests before database reconciliation. This is not a full live service acceptance result.

### Deletion side-effect ordering regression
`delete-account` now validates the prepared public-file plan and completes the authoritative `finish_account_deletion` financial guard **before** any Storage removal, global sign-out, or Auth soft deletion. A late financial hold therefore leaves public files untouched; transactional anonymization is rolled back by the database guard. A subsequent Storage failure retains the existing pending-cleanup response and does not continue to Auth deletion. Only public sample/avatar buckets are removed; private paid deliveries remain unchanged. Local actual-Edge mock regression: `tests/delete-account-edge.test.mjs`, four passing cases (finish rejection, invalid plan, successful ordering/private-delivery preservation, post-finish Storage failure). This is not a distributed transaction against financial events arriving after a successfully committed finish; retained obligation records remain necessary for later refunds.
