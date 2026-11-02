import {verifyTransferEvidence} from './transfer-evidence.mjs';

// The durable database claim is deliberately one-shot. Stripe's idempotency
// cache is not a permanent duplicate-payment guard. A lost response must be
// reconciled against a real transfer, never retried with a new create call.
export async function dispatchAppleSettlement({journal, stripe, recipient, verifyApple, platformId, enabled=false}) {
  if (!enabled) throw Error('settlement_disabled');
  const op=await journal.load();
  if (!op || !/^acct_[A-Za-z0-9]+$/.test(platformId||'') ||
      op.platform_id!==platformId || op.livemode!==true || op.currency!=='jpy' ||
      !Number.isSafeInteger(op.amount_jpy) || op.amount_jpy<=0 ||
      !/^acct_[A-Za-z0-9]+$/.test(op.destination||'') || op.destination===platformId ||
      !/^[0-9a-f-]{36}$/.test(op.id||'') || !/^[0-9a-f-]{36}$/.test(op.payment_id||'')) throw Error('settlement_identity_mismatch');
  const account=await stripe.accounts.retrieve();
  if (account.id!==platformId) throw Error('settlement_platform_mismatch');
  if (op.state!=='prepared') throw Error('settlement_reconciliation_required');
  if (await recipient(op.seller_id)!==op.destination) throw Error('settlement_recipient_changed');
  await verifyApple(op.payment_id);
  const balance=await stripe.balance.retrieve();
  const jpy=balance.available?.filter(x=>x.currency==='jpy');
  if (balance.object!=='balance'||balance.livemode!==true||jpy?.length!==1||
      !Number.isSafeInteger(jpy[0].amount)||jpy[0].amount<op.amount_jpy) throw Error('settlement_funding_required');
  // Claim revalidates payment, refund, allocation and recipient under a DB lock.
  await journal.claim(op.id);
  const transfer=await stripe.transfers.create({amount:op.amount_jpy,currency:'jpy',destination:op.destination,
    transfer_group:`apple_settlement_${op.id}`,
    metadata:{apple_settlement_id:op.id,payment_id:op.payment_id}},
    {idempotencyKey:`apple-settlement:${op.id}`,maxNetworkRetries:0});
  return reconcileAppleSettlement({op,transferId:transfer.id,stripe,journal});
}

export async function reconcileAppleSettlement({op,transferId,stripe,journal}) {
  if (!['dispatching','transferred','partially_reversed','reversed','prepared'].includes(op?.state) ||
      !/^tr_[A-Za-z0-9]+$/.test(transferId||'')) throw Error('settlement_reconciliation_required');
  // Never persist a create response or client-supplied amount as evidence.
  const transfer=await stripe.transfers.retrieve(transferId);
  if (transfer.metadata?.apple_settlement_id!==op.id || transfer.metadata?.payment_id!==op.payment_id ||
      transfer.transfer_group!==`apple_settlement_${op.id}`) throw Error('settlement_transfer_binding_mismatch');
  const evidence=verifyTransferEvidence(transfer,{id:transferId,destination:op.destination,
    amount:op.amount_jpy,currency:'jpy',sourceTransaction:null,livemode:true});
  await journal.record(op.id,transfer);
  return {...evidence,settlement:'bank_payout_unverified'};
}

// Claim is durable and one-shot even if the Stripe response is lost. Never
// derive a refund from a client assertion or from an empty StoreKit list.
export async function recoverAppleSettlement({op,stripe,journal,platformId,enabled=false,verifyRefund}) {
  if(!enabled)throw Error('settlement_recovery_disabled');
  if(op?.platform_id!==platformId||(await stripe.accounts.retrieve()).id!==platformId)throw Error('settlement_platform_mismatch');
  await verifyRefund(op.payment_id);
  await reconcileAppleSettlement({op,transferId:op.transfer_id,stripe,journal});
  const recovery=await journal.claimRecovery(op.id);
  if(recovery.transfer_id!==op.transfer_id||!Number.isSafeInteger(recovery.amount_jpy)||recovery.amount_jpy<=0)throw Error('settlement_recovery_mismatch');
  const reversal=await stripe.transfers.createReversal(recovery.transfer_id,{
    amount:recovery.amount_jpy,metadata:{apple_recovery_id:recovery.id,apple_settlement_id:op.id}
  },{idempotencyKey:`apple-recovery:${recovery.id}`,maxNetworkRetries:0});
  return reconcileAppleRecovery({op,stripe,journal,reversalId:reversal.id});
}

export async function reconcileAppleRecovery({op,stripe,journal,reversalId}) {
  if(!/^trr_[A-Za-z0-9]+$/.test(reversalId||'')||!/^tr_[A-Za-z0-9]+$/.test(op?.transfer_id||''))throw Error('settlement_recovery_mismatch');
  // The transfer (which has livemode and destination) and reversal must both
  // be freshly retrieved. The reversal object itself has no livemode field.
  await reconcileAppleSettlement({op,transferId:op.transfer_id,stripe,journal});
  const evidence=await stripe.transfers.retrieveReversal(op.transfer_id,reversalId);
  await journal.recordRecovery(op.id,evidence);
  return {recovery:'verified',financialAdjustment:'pending',bankPayout:'unverified'};
}

// Called only after the webhook endpoint verifies signature and live mode.
export async function reconcileAppleSettlementEvent({event,db,stripe,platformId}) {
  if (!['transfer.created','transfer.updated','transfer.reversed'].includes(event.type) ||
      !event.data?.object?.metadata?.apple_settlement_id) return false;
  const operation=event.data.object.metadata.apple_settlement_id;
  if (event.livemode!==true||event.account||!/^[0-9a-f-]{36}$/.test(operation)) throw Error('settlement_event_mismatch');
  const {data:op,error}=await db.rpc('get_apple_settlement',{operation});
  if (error||!op||op.platform_id!==platformId||(await stripe.accounts.retrieve()).id!==platformId) throw Error('settlement_event_unmatched');
  await reconcileAppleSettlement({op,transferId:event.data.object.id,stripe,journal:{record:async(id,evidence)=>{
    const {error}=await db.rpc('record_apple_settlement',{operation:id,evidence});
    if(error)throw Error('settlement_persistence_pending');
  }}});
  return true;
}
