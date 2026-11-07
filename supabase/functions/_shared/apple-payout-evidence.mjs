import {verifyTransferEvidence} from './transfer-evidence.mjs';

const idOf = value => typeof value === 'string' ? value : value?.id;
const idIs = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value);
const integer = value => Number.isSafeInteger(value);
const fail = reason => { throw new Error(`apple_payout_${reason}`); };

// Pure, fail-closed verifier. Only a trusted server collector may supply these
// envelopes; context is collector metadata, NOT fields invented on Stripe objects.
// No API calls, money movement, ledger completion or account-deletion release.
// Freshness is an explicit caller policy, never inferred from object.created.
export function verifyApplePayoutEvidence({expected, transfer, destinationPayment, payout, payoutTransactions, nowMs, maxAgeMs}) {
  if (!expected || !idIs(expected.platformId,'acct') || !idIs(expected.destination,'acct') ||
      expected.platformId===expected.destination || !idIs(expected.transferId,'tr') ||
      !idIs(expected.payoutId,'po') || !idIs(expected.bankAccountId,'ba') ||
      expected.currency!=='jpy' || expected.livemode!==true || !integer(expected.amountJpy) || expected.amountJpy<=0 ||
      typeof expected.settlementId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.settlementId) ||
      typeof expected.paymentId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.paymentId) ||
      !integer(nowMs) || nowMs<0 || !integer(maxAgeMs) || maxAgeMs<=0) fail('expectation_invalid');
  const read = (envelope, accountId) => {
    const c=envelope?.context;
    if (!c || c.source!=='stripe_server_api' || c.accountId!==accountId || c.livemode!==true ||
        !idIs(c.requestId,'req') || typeof c.apiVersion!=='string' || !c.apiVersion ||
        !integer(c.retrievedAtMs) || c.retrievedAtMs<0 || c.retrievedAtMs>nowMs || nowMs-c.retrievedAtMs>maxAgeMs) fail('context_invalid_or_stale');
    return envelope.data;
  };
  const t=read(transfer,expected.platformId),d=read(destinationPayment,expected.destination),p=read(payout,expected.destination),list=read(payoutTransactions,expected.destination);
  const verified=verifyTransferEvidence(t,{id:expected.transferId,destination:expected.destination,amount:expected.amountJpy,currency:'jpy',sourceTransaction:null,livemode:true});
  if (verified.state!=='transferred' || t.metadata?.apple_settlement_id!==expected.settlementId ||
      t.metadata?.payment_id!==expected.paymentId || t.transfer_group!==`apple_settlement_${expected.settlementId}`) fail('transfer_unresolved');
  if (!idIs(idOf(t.destination_payment),'py') || d?.object!=='charge' || d.id!==idOf(t.destination_payment) ||
      idOf(d.source_transfer)!==t.id || d.livemode!==true || d.currency!=='jpy' || d.amount!==expected.amountJpy ||
      d.amount_captured!==expected.amountJpy || d.captured!==true || d.paid!==true || d.status!=='succeeded' ||
      d.refunded!==false || d.amount_refunded!==0 || d.disputed!==false || d.failure_balance_transaction!==null ||
      d.failure_code!==null || d.failure_message!==null ||
      !idIs(idOf(d.balance_transaction),'txn')) fail('destination_credit_unresolved');
  if (p?.object!=='payout' || p.id!==expected.payoutId || p.livemode!==true || p.currency!=='jpy' ||
      !integer(p.amount) || p.amount<=0 || p.automatic!==true || p.method!=='standard' ||
      p.reconciliation_status!=='completed' || p.type!=='bank_account' || idOf(p.destination)!==expected.bankAccountId ||
      p.status!=='paid' || p.failure_balance_transaction!==null || p.failure_code!==null || p.failure_message!==null ||
      p.reversed_by!==null || p.original_payout!==null) fail('payout_not_verified_paid');
  // A single terminal page is not proof of complete pagination. The collector
  // must attest all pages, and preserve the exact payout filter/account scope.
  if (payoutTransactions.context.paginationComplete!==true || payoutTransactions.context.payoutId!==p.id ||
      list?.object!=='list' || list.has_more!==false || !Array.isArray(list.data) || !list.data.length) fail('membership_incomplete');
  const ids=new Set();
  for (const row of list.data) {
    if (row?.object!=='balance_transaction' || !idIs(row.id,'txn') || ids.has(row.id) || row.currency!=='jpy') fail('membership_invalid');
    ids.add(row.id);
  }
  const row=list.data.find(row=>row.id===idOf(d.balance_transaction));
  if (!row || idOf(row.source)!==d.id || row.amount!==expected.amountJpy || !integer(row.fee) || row.fee<0 ||
      !integer(row.net) || row.net!==row.amount-row.fee || row.net<=0 || row.status!=='available') fail('membership_credit_mismatch');
  // Attribution is weaker than full bank settlement: mixed debits/fees or
  // unexplained payout totals must never release a seller obligation.
  const batchArithmeticValid=list.data.every(x=>integer(x.amount)&&integer(x.fee)&&integer(x.net)&&x.fee>=0&&x.net===x.amount-x.fee);
  const total=batchArithmeticValid?list.data.reduce((sum,x)=>sum+BigInt(x.net),0n):null;
  const batchNetTotalJpy=total!==null&&total>=BigInt(Number.MIN_SAFE_INTEGER)&&total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):null;
  const batchAllPositiveNoFees=batchArithmeticValid&&list.data.every(x=>x.amount>0&&x.fee===0&&x.net===x.amount&&x.status==='available');
  const batchMatchesPayout=batchNetTotalJpy!==null&&batchNetTotalJpy===p.amount;
  return {
    batchAllPositiveNoFees,batchNetTotalJpy,batchMatchesPayout,
    transferId:t.id,destination:expected.destination,destinationPaymentId:d.id,balanceTransactionId:row.id,payoutId:p.id,
    creditAmountJpy:row.amount,creditFeeJpy:row.fee,creditNetJpy:row.net,payoutAmountJpy:p.amount,
    assignmentVerified:true,stripePayoutPaid:true,bankReceipt:'unverified',bankReceiptVerified:false,settlementComplete:false,
  };
}
