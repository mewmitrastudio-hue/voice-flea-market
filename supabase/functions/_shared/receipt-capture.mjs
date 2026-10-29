// Never treat a browser confirmation or a successful POST as settled money.
// Stripe must confirm the immutable payment again before the database accepts delivery.
export class ReceiptError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReceiptError(code); };
const id = value => typeof value === 'string' ? value : value?.id;
export function verifyReceiptPayment(pi, payment, live) {
  const charge = pi?.latest_charge;
  if (!pi || pi.id !== payment.stripe_payment_intent_id || pi.livemode !== live ||
      payment.stripe_livemode !== live || pi.currency !== 'jpy' ||
      !Number.isSafeInteger(payment.amount_jpy) || payment.amount_jpy < 50 ||
      pi.amount !== payment.amount_jpy || !charge || typeof charge !== 'object' ||
      !/^ch_[A-Za-z0-9]+$/.test(charge.id || '') || charge.payment_intent !== pi.id ||
      charge.livemode !== live || charge.currency !== 'jpy' || charge.amount !== pi.amount ||
      charge.paid !== true || charge.amount_refunded !== 0 ||
      (payment.stripe_charge_id && payment.stripe_charge_id !== charge.id)) fail('payment_mismatch');
  if (payment.stripe_capture_method === 'manual') {
    if (pi.capture_method !== 'manual' || !/^acct_[A-Za-z0-9]+$/.test(payment.stripe_destination || '') ||
        id(pi.transfer_data?.destination) !== payment.stripe_destination ||
        pi.application_fee_amount !== payment.platform_fee_jpy ||
        payment.platform_fee_jpy !== Math.round(payment.amount_jpy * 0.15) ||
        payment.seller_amount_jpy !== payment.amount_jpy - payment.platform_fee_jpy) fail('destination_mismatch');
  }
  return charge;
}
export async function captureReceipt({payment, stripe, live, now = () => Date.now()}) {
  if (!payment || !/^pi_[A-Za-z0-9]+$/.test(payment.stripe_payment_intent_id || '')) fail('payment_unavailable');
  const path = `payment_intents/${payment.stripe_payment_intent_id}`;
  let pi = await stripe.get(path, {expand:['latest_charge']});
  let charge = verifyReceiptPayment(pi, payment, live);
  if (pi.status === 'requires_capture') {
    const expires = charge.payment_method_details?.card?.capture_before;
    if (payment.status !== 'authorized' || payment.stripe_capture_method !== 'manual' ||
        charge.captured !== false || charge.amount_captured !== 0 ||
        pi.amount_capturable !== payment.amount_jpy || !Number.isSafeInteger(expires) ||
        expires * 1000 <= now()) fail('authorization_expired_or_unavailable');
    // The same durable payment always uses the same key, even after a timeout/restart.
    await stripe.capture(pi.id, {amount_to_capture:payment.amount_jpy}, `receipt-capture:${payment.id}`);
    pi = await stripe.get(path, {expand:['latest_charge']});
    charge = verifyReceiptPayment(pi, payment, live);
  }
  if (pi.status !== 'succeeded' || charge.captured !== true ||
      charge.amount_captured !== payment.amount_jpy) fail('capture_unconfirmed');
  const transferId = id(charge.transfer);
  if (payment.stripe_capture_method === 'manual' && !/^tr_[A-Za-z0-9]+$/.test(transferId || '')) fail('transfer_unconfirmed');
  if (payment.stripe_capture_method === 'manual') {
    const transfer = await stripe.get(`transfers/${transferId}`, {});
    if (transfer?.id !== transferId || transfer.livemode !== live || transfer.currency !== 'jpy' ||
        transfer.amount !== payment.amount_jpy || id(transfer.destination) !== payment.stripe_destination ||
        id(transfer.source_transaction) !== charge.id || transfer.reversed !== false || transfer.amount_reversed !== 0) fail('transfer_unconfirmed');
  }
  return {stripe_payment_intent_id:pi.id, stripe_charge_id:charge.id, stripe_livemode:live,
    amount_jpy:charge.amount, refunded_amount_jpy:0, stripe_reconciled_at:new Date(now()).toISOString(),
    transfer_id:transferId || null};
}

export async function cancelReceiptAuthorization({payment,stripe,live}) {
  const validate = pi => {
    if (!payment || !['authorized','canceled'].includes(payment.status) || payment.stripe_capture_method !== 'manual' ||
        !/^pi_[A-Za-z0-9]+$/.test(payment.stripe_payment_intent_id || '') || pi?.id !== payment.stripe_payment_intent_id ||
        pi.livemode !== live || payment.stripe_livemode !== live || pi.currency !== 'jpy' || pi.amount !== payment.amount_jpy ||
        pi.capture_method !== 'manual' || id(pi.transfer_data?.destination) !== payment.stripe_destination ||
        pi.application_fee_amount !== payment.platform_fee_jpy) fail('authorization_mismatch');
  };
  let pi=await stripe.get(`payment_intents/${payment.stripe_payment_intent_id}`,{});validate(pi);
  if (pi.status === 'requires_capture') {
    await stripe.cancel(pi.id,{},`authorization-cancel:${payment.id}`);
    pi=await stripe.get(`payment_intents/${payment.stripe_payment_intent_id}`,{});validate(pi);
  }
  if (pi.status !== 'canceled') fail('authorization_cancellation_unconfirmed');
  return {paymentIntentId:pi.id,canceled:true};
}
