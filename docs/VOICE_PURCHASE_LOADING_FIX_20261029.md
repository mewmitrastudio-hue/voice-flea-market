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
