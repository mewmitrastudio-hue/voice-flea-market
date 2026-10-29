# Apple financial report import — 2026-10-29

The operator can preview and save an extracted tab-separated Apple financial
report in the dashboard. This fills the missing document intake step; it does
not finish seller settlement.

The server accepts Apple's standard Vendor Identifier and detailed SKU report
headers. It checks fiscal dates, signed units, currency codes and the equality
of unit proceeds multiplied by quantity to extended proceeds. Integer decimal
arithmetic preserves up to six fractional digits without floating point
rounding. Different currencies and unrelated products remain separate. No
exchange rate or Apple commission rate is assumed.

The original UTF-8 text and normalized report are retained privately. The
database recomputes the server SHA-256 fingerprint from the source text;
reimporting identical bytes is idempotent. The operator history exposes only
the file name, period and currency totals. Raw documents and writes are not
available to anonymous or authenticated database clients. Edge authentication
checks the current user, and the database independently checks the operator
registry and account availability. Private UI state is cleared on logout and
stale responses are discarded after an account or file change.

All saved reports are explicitly labelled **unreconciled documents**. Uploads
are operator-supplied documents, not signed Apple payment evidence. Financial
reports contain aggregate units; they are not an exact transaction ID mapping.
Import changes no payment, seller allocation, bank balance, refund, payout or
account deletion eligibility. Actual transaction allocation, adjustment and
refund handling, seller settlement and bank receipt evidence remain required.
No hypothetical net amount or synthetic report has been stored in production.

The additive migration and `apple-financial-reports` Edge v1 are deployed.
The frontend is a draft candidate for release 2026.10.29-3 / build 28, not the
installed build 27 or the public main website. New sales remain disabled.
Live checks confirmed denied anonymous requests, service-only import RPC,
private raw reports with RLS enabled, and a working authenticated operator
history query. Existing security warning categories/counts were unchanged.

Validation: 131 application tests passed, including eight new parser, Edge,
SQL permission/integrity/idempotency and UI account isolation scenarios.
The final source passed native asset synchronization and build preparation
for build 28. No signed build 28 distribution or physical purchase test is
claimed. The installed build 27 has been shown opening on an actual iPhone.

Apple references checked on 2026-10-29:

- https://developer.apple.com/help/app-store-connect/reference/reporting/financial-report-fields/
- https://developer.apple.com/help/app-store-connect/getting-paid/download-financial-reports/

Release gates remain: seller settlement, abandoned prepared job-order
recovery, controlled Sandbox configuration, actual ordinary purchases and
all three boosts through cancellation/retry/refund/deletion, final signed
distribution, and review assets. Keep the PR a draft and do not submit to Apple.
