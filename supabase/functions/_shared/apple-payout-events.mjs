// Caller must first verify the Stripe webhook signature. Failure events can
// reopen an obligation only; they never approve a receipt or move money.
export async function reconcileApplePayoutFailure({event,stripe,db}) {
 if(!['payout.failed','payout.canceled'].includes(event?.type))return false;
 const p=event.data?.object;
 if(event.livemode!==true||!/^evt_[A-Za-z0-9]+$/.test(event.id||'')||!/^acct_[A-Za-z0-9]+$/.test(event.account||'')||p?.object!=='payout'||p.livemode!==true||!/^po_[A-Za-z0-9]+$/.test(p.id||''))throw Error('payout_event_mismatch');
 const fresh=await stripe.payouts.retrieve(p.id,{}, {stripeAccount:event.account});
 if(fresh.object!=='payout'||fresh.id!==p.id||fresh.livemode!==true||!['failed','canceled'].includes(fresh.status))throw Error('payout_failure_unconfirmed');
 const {error}=await db.rpc('invalidate_apple_bank_payout',{destination:event.account,payout:p.id,event_id:event.id});if(error)throw Error('payout_invalidation_not_persisted');
 return true;
}
