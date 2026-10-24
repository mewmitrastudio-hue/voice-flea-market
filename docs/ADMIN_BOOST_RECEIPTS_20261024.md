The operator dashboard previously read only ordinary voice payments; verified Apple boosts were absent. This adds a separate boost receipt section, with all-record aggregates for Production and Sandbox and ten receipts per page.

The public RPC is SECURITY INVOKER. Its private implementation rejects callers outside the existing operator allowlist and unavailable accounts. No table policy is widened, no purchases or refunds are created, and ordinary user RLS is unchanged. Receipt pagination uses (created_at, id), so rows sharing a timestamp cannot disappear between pages. Refreshes and account switches invalidate stale responses; a failed next page preserves existing receipts.

Amounts are the plan reference prices recorded by the existing Apple grant function, not verified localized charges or Apple net proceeds. The UI labels this explicitly. Sandbox receipts are never included in Production aggregates. Apple financial reports and bank deposits still need separate reconciliation.

Validation: PostgreSQL/PGlite authorization, denied anonymous and ordinary access, intact table RLS, mixed environments, cancelled and expired grants, 25 same-time receipts across pages, incomplete cursors, plus UI retry and stale response tests. Existing app tests are run with this change.

Release 2026.10.24-1 prepares minimum iOS build 25. TestFlight build 24 remains the last distributed native build until a new signed build is produced. The change does not enable Production sales or switch Stripe runtime keys.
