// Call only with a fresh server-side Stripe retrieve response and expected
// values loaded from the server ledger. This proves a Connect transfer, never
// a bank payout. It neither creates a transfer nor changes a settlement ledger.
const objectId = value => typeof value === 'string' ? value : value?.id;
const matchesId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
export function verifyTransferEvidence(transfer, expected) {
  if (!expected || !matchesId(expected.id, 'tr') || !matchesId(expected.destination, 'acct') ||
      typeof expected.livemode !== 'boolean' || !Number.isSafeInteger(expected.amount) || expected.amount <= 0 ||
      expected.currency !== 'jpy' || !(expected.sourceTransaction === null || matchesId(expected.sourceTransaction, 'ch')) ||
      transfer?.object !== 'transfer' || transfer.id !== expected.id || transfer.livemode !== expected.livemode ||
      transfer.amount !== expected.amount || transfer.currency !== expected.currency ||
      objectId(transfer.destination) !== expected.destination ||
      (transfer.source_transaction === null ? null : objectId(transfer.source_transaction)) !== expected.sourceTransaction ||
      !Number.isSafeInteger(transfer.amount_reversed) || transfer.amount_reversed < 0 || transfer.amount_reversed > transfer.amount ||
      typeof transfer.reversed !== 'boolean' || transfer.reversed !== (transfer.amount_reversed === transfer.amount)) {
    throw new Error('transfer_evidence_mismatch');
  }
  return {
    transferId: transfer.id,
    destination: expected.destination,
    amountJpy: transfer.amount,
    reversedJpy: transfer.amount_reversed,
    remainingJpy: transfer.amount - transfer.amount_reversed,
    state: transfer.reversed ? 'reversed' : transfer.amount_reversed > 0 ? 'partially_reversed' : 'transferred',
    bankPayout: 'unverified',
  };
}
