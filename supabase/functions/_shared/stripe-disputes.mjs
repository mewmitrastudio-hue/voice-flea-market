// Read-only provider reconciliation. No refund, capture, reversal or payout API.
export const stripeDisputeEvents = ['charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'];
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[A-Za-z0-9]+$').test(v);
const ref=v=>typeof v==='string'?v:v?.id;
export async function reconcileStripeDispute({event,get,db,live,platformId,now=()=>new Date().toISOString()}){
 const obj=event?.data?.object;
 if(!stripeDisputeEvents.includes(event?.type)||!id(event.id,'evt')||!Number.isSafeInteger(event.created)||event.created<=0
 ||event.livemode!==live||event.account!=null||event.context!=null||!id(platformId,'acct')
 ||obj?.object!=='dispute'||!id(obj.id,'dp')||!id(ref(obj.charge),'ch')||obj.livemode!==live)throw Error('Dispute event scope mismatch');
 const observed=now();
 const account=await get('account');
 if(account.id!==platformId)throw Error('Dispute platform mismatch');
 const d=await get('disputes/'+encodeURIComponent(obj.id));
 if(d.id!==obj.id||d.object!=='dispute'||d.livemode!==live||ref(d.charge)!==ref(obj.charge)
 ||!id(ref(d.payment_intent),'pi')||ref(obj.payment_intent)!==ref(d.payment_intent)
 ||d.currency!=='jpy'||!Number.isSafeInteger(d.amount)||d.amount<=0||typeof d.status!=='string'||!d.status.length||d.status.length>80)throw Error('Dispute identity mismatch');
 const charge=await get('charges/'+encodeURIComponent(ref(d.charge)));
 const pi=await get('payment_intents/'+encodeURIComponent(ref(d.payment_intent)));
 if(charge.id!==ref(d.charge)||charge.object!=='charge'||charge.livemode!==live||ref(charge.payment_intent)!==pi.id
 ||pi.id!==ref(d.payment_intent)||pi.object!=='payment_intent'||pi.livemode!==live||pi.currency!=='jpy'
 ||ref(pi.latest_charge)!==charge.id||charge.currency!=='jpy'||!Number.isSafeInteger(charge.amount)||charge.amount<=0
 ||pi.amount!==charge.amount||charge.paid!==true||charge.captured!==true||charge.amount_captured!==charge.amount
 ||!Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0||charge.amount_refunded>charge.amount
 ||!id(ref(pi.transfer_data?.destination),'acct'))throw Error('Dispute charge mismatch');
 // Disputed amount may exceed the original charge in some provider flows; do not fabricate a cap or fee.
 const due=d.evidence_details?.due_by;
 if(due!=null&&(!Number.isSafeInteger(due)||due<=0))throw Error('Dispute deadline invalid');
 const snapshot={event_id:event.id,event_type:event.type,event_created:event.created,platform_id:platformId,livemode:live,
 dispute_id:d.id,charge_id:charge.id,payment_intent_id:pi.id,status:d.status,amount_jpy:d.amount,currency:d.currency,
 charge_amount_jpy:charge.amount,refunded_amount_jpy:charge.amount_refunded,destination:ref(pi.transfer_data.destination),
 buyer_id:pi.metadata?.buyer_id,seller_id:pi.metadata?.seller_id,listing_id:pi.metadata?.listing_id||null,job_id:pi.metadata?.job_id||null,
 transfer_id:ref(charge.transfer)||null,evidence_due_by:due?new Date(due*1000).toISOString():null,observed_at:observed};
 if(snapshot.transfer_id!==null&&!id(snapshot.transfer_id,'tr'))throw Error('Dispute transfer invalid');
 const {error}=await db.rpc('record_stripe_dispute_observation',{snapshot});
 if(error)throw Error('Dispute persistence pending');
 return {reviewRequired:true};
}
