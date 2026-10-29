# Voice purchase preparation recovery — 2026-10-29

On an actual TestFlight build 27, opening the JPY1000 voice purchase remained on
the generic loading message. Server preparation requests returned HTTP 200 and
the same Sandbox quote was durable; there was no completed Apple payment.
Without native stage telemetry, the exact stalled native operation is not
established. Do not report a confirmed StoreKit or Apple configuration cause.

The client previously awaited native initialization, unfinished transaction
enumeration, server preparation and Apple product lookup without a deadline.
Closing the overlay also left `voicePurchaseBusy` set until that promise settled.
A lost response could therefore disable subsequent attempts indefinitely.

Each preparation read now has a 20-second deadline and its own progress message.
Failure shows which check did not complete, hides the purchase button and
releases the preparation lock. A missing preparation response retains the same
attempt ID, because a server quote may already exist. Closing preparation
invalidates its request and allows reopening; stale results and stale `finally`
blocks cannot alter a newer attempt. No charge starts during these reads.

Actual StoreKit purchase remains protected by its existing lock. Closing that
overlay does not unlock a second purchase, and no artificial deadline has been
placed around the financial purchase operation. Durable server verification
still precedes finishing the signed Apple transaction.

New deterministic runtime tests simulate native initialization, unfinished
transaction enumeration, server and product lookup that never respond. They
also cover late product responses, retained attempt identity, close/reopen
overlap, stale lock release and closing during actual purchase. They do not
replace an actual iPhone purchase test. The candidate release is 2026.10.29-4,
with minimum build 28; installed build 27 cannot receive this bundled JS fix
until a new signed binary is installed.

## Build 28 follow-up

The user confirmed installing build 28, then supplied an actual iPhone image
showing the combined product/environment/currency/price error, rather than a
permanent spinner. The server order remains prepared, SKU voice.jpy1000,
amount JPY1000, environment Sandbox. No Apple
payment exists. The image does not establish which of the four comparisons
failed. Do not describe it as a proven numerical price mismatch.

The native implementation previously treated any receipt URL other than
`sandboxReceipt`, including a missing URL, as Production. Apple's documentation
states sandbox app receipts may initially be absent. The new source uses the
verified `AppTransaction.shared` environment on iOS 16+, with a matching bundle
ID. iOS 15 recognizes explicit receipt names only. Unknown and Xcode
environments are not silently classified as Production. The purchase lock is
acquired before awaiting environment verification. Products still come from
StoreKit, and actual purchases still require native amount/currency matching
and durable, server-verified Apple receipts.

The web preparation code now reports distinct error codes V01 environment,
V02 unavailable product, V03 non-JPY currency and V04 mismatched price. A valid
quote reaches the Apple purchase adapter and receipt verification/finish/chat
sequence in the controlled runtime scenario. This does not prove an actual
Apple payment or that environment detection caused the user's observed error.

The follow-up is source-only, release 2026.10.29-5. No iOS SDK compilation,
signed build, upload or distribution was performed after the user stopped
builds. Installed build 28 cannot receive the modified native implementation
without an app update. Actual device confirmation remains required.

Apple references checked:
https://developer.apple.com/documentation/foundation/bundle/appstorereceipturl
https://developer.apple.com/documentation/storekit/apptransaction/shared
https://developer.apple.com/documentation/storekit/apptransaction/environment
