# Apple purchase preparation: preflight before reservation

The voice-iap endpoint previously created/reused a durable prepared order before checking the payment environment and seller recipient readiness. A failed check could therefore leave a job order blocking another payment channel even though no purchase quote had reached the client.

The endpoint now checks the environment, resolves the seller from server-owned listing/application/job records, and checks recipient readiness before calling the reservation RPC. Job ownership is checked before contacting the recipient service. The RPC remains authoritative for frozen terms, price, account availability, blocks, products and concurrency. Its seller must match the seller checked by the endpoint before a quote is returned.

Paid receipt verification continues before all new-sale preparation gates. No pending or paid Apple order is deleted or expired by this change. A failed recipient check on an existing order does not erase it.

Regression coverage includes ordinary and job purchases, missing/mismatched configuration, unavailable recipients, foreign job buyers, seller changes between preflight and reservation, and paid receipt recovery while new sales are disabled.

Limitations: this prevents reservations for known preflight failures; it does not implement abandoned-order expiration or payment-channel switching. Recipient readiness can change after it is checked, so settlement still needs its independent checks. Real StoreKit purchase, settlement/refund execution and Apple release gates remain separate.
