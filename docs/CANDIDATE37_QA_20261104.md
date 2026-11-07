# Candidate37: Web checkout recovery

Release2026.11.04-3 / minimum build37. Web SHA256:9ff5cef62f96e2b30967b24892e443574b398771b441ac27679bcadf9cb90bed. Native source is unchanged from candidate36.

Fixes: purchase controls reset after successful exact-session reconciliation; pending reconciliation retains the warning not to repurchase; late checkout responses cannot redirect or show stale UI after navigation or account changes. Verified existing transactions still reconcile after navigation, without reopening old UI. Pending exact-session records and attempt identifiers are retained for recovery. No timeout-clearing or guessed payment success was introduced.

14 new regression cases cover these flows, including navigating away and back, account switching and retries. See CHECKOUT_RECOVERY_AUDIT_20261104.md for detailed evidence and the earlier resource-limited run.

Candidate36 remains the signed installed version: App Store Connect confirmed1.0(36) installed on the existing internal tester's iPhone15/iOS27.0.1 at10:15UTC. This code is not included in that binary until a separate build37 is signed/uploaded. See RECORDING_READINESS_20261104.md for the exact remaining recording and review gates.

The production-backend marker and both sales flags remain false. No production deployment, financial transaction, account deletion, main merge, formal review or public release is performed by this change.

Final fixed-source rerun at10:24UTC: all393 application tests passed,0failed,0skipped; Apple verifier Worker15passed. CI_BUILD_NUMBER=37 bundle preparation and ios:verify passed. The earlier worktree SIGKILLs were not reproduced in this aggregate run. GitHub CI and signed build37 are separate pending stages.
