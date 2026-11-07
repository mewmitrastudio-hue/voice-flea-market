# Apple manual evidence panel — local candidate only

## UI route
Operator dashboard → Apple返金・銀行入金の資料照合（運営確認）.
The client admin identity check controls presentation only. Every server request carries the current authenticated user token, and `apple-financial-resolution` must independently validate the operator identity and authoritative records. No client flag grants server permission.

## Actions / data
- `previewAdjustment`: stable operation UUID, payment UUID, imported report UUID, return row number, association note.
- `previewBankReceipt`: operation/payment UUID, Payout and bank-account reference IDs, actual statement SHA256, non-sensitive bank reference, received date, whole-Payout amount JPY, note.
- `approve`: operation UUID, exact stored preview SHA256, explicit confirmation.
- `status`: same operation UUID.

Original bank statement can be selected locally (maximum 10 MB) to compute SHA256. Raw file content is not sent to the server. File hash identifies the evidence file but does not independently authenticate the bank statement. Operator must inspect the original. Do not put bank account numbers, credentials, API keys or unrelated personal information into reference/note fields.

The server summary is rendered in full using textContent, capped at 16 KB. Missing/malformed status, mismatched operation IDs, unknown result types or unsupported completion assertions fail closed. Both explicit checkbox and confirmation dialog are needed before approval.

## Result semantics
- A preview is not approval.
- Adjustment approval binds report facts, not a guessed seller debit or money movement.
- Stripe paid is not a bank-side receipt proof.
- Bank completion text requires server state approved, settlementComplete true, reviewRequired false, kind bank and summary.operatorBankReceiptApproved true.
- The latter is an audited operator bank-statement approval, not an automatic bank API verification.
- Unresolved additional fees, shortages or refund policy remain held. No UI request performs refunds, transfers or bank-account changes.

## Interruption / duplicate protection
An operation ID (no financial details/notes) is durably recorded per operator before preview. While in flight, input and buttons are disabled. A lost response keeps the ID and permits only status lookup, including after reload. An explicit server `operation_not_found` result permits a same-ID preview retry; it never automatically generates a replacement ID. Original input must be rechecked/re-entered after reload. Stored server operation payload/replay checks remain authoritative.

Account changes clear private preview/form state and reject late results. Editing a confirmed preview invalidates the local approval and requires another preview. Approved/invalidated terminal responses can clear the local pending pointer. The server journal, not this browser pointer, enforces replay safety across browsers.

## Verification
Dedicated `tests/apple-manual-evidence-ui.test.mjs`: 17 passed. Combined with existing Apple report/proceeds tests: 29 passed, 0 failed (`/tmp/apple-manual-ui.log`). Tests cover session/account changes, concurrent clicks, explicit/canceled approval, malformed results, persistent unknown responses, same-ID recovery, hold semantics and local-only statement hashing.

Existing report UI test fixture gained `querySelectorAll` for the new private-state reset integration; assertions remain unchanged. No browser/real-iPhone execution performed because the previously observed Chromium socket restriction remains. No deployment, server write, live financial action or review submission performed by this UI task. Endpoint/DB migration integration is being implemented separately and must be tested/deployed under appropriate authority before real operator use.
