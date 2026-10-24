# Operator-only support desk

The dedicated app route is `#admin-support`. The operator menu opens the same
support desk. Access uses the existing moderator roster; at rollout its only
member is the verified Suematsu account. Frontend menu visibility is not the
security boundary: the private RPC independently checks authenticated moderator
status and account availability. The public wrapper is SECURITY INVOKER and
anonymous execution is revoked.

The desk includes receipt ID, subject/body, reply address, open/reviewing/closed
status, automatic acknowledgement status, server-side literal search and ten-row
cursor pagination. Closed inquiries remain searchable. Late account responses
are discarded and private rows are cleared on sign-out/account changes. The
report queue remains separate.

A public-support form bug is corrected: its explicit reply email is stored in
reply_email as well as the existing message, so the acknowledgement worker and
operator desk can identify it. Historical messages are not parsed or bulk mailed.

Private support acknowledgement backend was deployed and tested separately.
One real operator inquiry was submitted from the logged-in app. Its receipt
email was verified in the operator's INBOX before activation. The subject is
「【声のフリマ】お問い合わせを受け付けました」 and the text states that the
content will be checked and a response provided. One durable receipt per inquiry,
per-address cooldown, fixed text without forwarding the submitted question,
address validation and bounded retries prevent common duplicate/abuse cases.
Welcome email remains enabled. No mass announcement was sent.

Direct SMTP receipt at support@koe-furima.com has not been set up in this change:
a current DNS MX lookup returned no MX answer. This app intake page is not a
Gmail inbox, and app auto-replies must not be represented as direct-mail inbound
processing. Provider delivery lookup is also limited by the current API access;
actual operator inbox reception is independently verified.

Validation: 72 combined public/private tests pass, including SQL pagination over
1,250 inquiries, status history, literal-percent search, anonymous/ordinary-user
rejection, failed pagination and account-switch isolation. This does not complete
normal iOS purchases, receipt-time capture, real seller payout, automatic refunds,
or the final Apple device workflow.
