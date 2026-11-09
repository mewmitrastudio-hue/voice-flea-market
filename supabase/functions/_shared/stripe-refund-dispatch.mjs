// One permanent application dispatch claim shared by manual and automatic routes.
// Provider calls are injected for local tests. A non-prepared operation is read-only forever.
const ref=v=>typeof v==='string'?v:v?.id;
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[A-Za-z0-9]+$').test(v);
export class RefundReview extends Error {constructor(code){super(code);this.code=code;}}
async function rpc(db,name,args){const {data,error}=await db.rpc(name,args);if(error)throw new RefundReview(name+'_pending');return data;}
export function verifyRefundPayment(payment,pi,charge,live){
 if(payment.payment_channel!=='web'||payment.apple_transaction_id!=null||payment.apple_environment!=null||payment.apple_verified_at!=null
 ||!id(payment.stripe_payment_intent_id,'pi')||!id(payment.stripe_charge_id,'ch')||payment.stripe_livemode!==live
 ||pi?.object!=='payment_intent'||pi.id!==payment.stripe_payment_intent_id||pi.livemode!==live||pi.status!=='succeeded'||pi.currency!=='jpy'
 ||pi.amount!==payment.amount_jpy||ref(pi.latest_charge)!==payment.stripe_charge_id
 ||charge?.object!=='charge'||charge.id!==payment.stripe_charge_id||ref(charge.payment_intent)!==pi.id||charge.livemode!==live||charge.currency!=='jpy'
 ||charge.amount!==payment.amount_jpy||charge.paid!==true||charge.captured!==true||charge.amount_captured!==payment.amount_jpy
 ||!Number.isSafeInteger(charge.amount_refunded)||charge.amount_refunded<0||charge.amount_refunded>payment.amount_jpy
 ||typeof charge.disputed!=='boolean'||typeof charge.refunded!=='boolean'
 ||!id(payment.stripe_destination,'acct')||ref(pi.transfer_data?.destination)!==payment.stripe_destination
 ||!Number.isSafeInteger(payment.platform_fee_jpy)||payment.platform_fee_jpy<0||pi.application_fee_amount!==payment.platform_fee_jpy
 ||pi.metadata?.buyer_id!==payment.buyer_id||pi.metadata?.seller_id!==payment.seller_id
 ||(pi.metadata?.listing_id||null)!==(payment.listing_id||null)||(pi.metadata?.job_id||null)!==(payment.job_id||null))throw new RefundReview('payment_identity_or_capture_mismatch');
 return {stripe_payment_intent_id:pi.id,stripe_charge_id:charge.id,stripe_livemode:live,amount_jpy:charge.amount,refunded_amount_jpy:charge.amount_refunded,
 currency:'jpy',disputed:charge.disputed,refunded:charge.refunded,destination:payment.stripe_destination,application_fee_jpy:pi.application_fee_amount};
}
export function verifyRefundObject(r,p,expectedId=null){
 // Refund objects do not contain a livemode field. Scope is proved by platform + PI/charge retrieval.
 if(r?.object!=='refund'||!id(r.id,'re')||(expectedId!==null&&r.id!==expectedId)||ref(r.payment_intent)!==p.stripe_payment_intent_id
 ||ref(r.charge)!==p.stripe_charge_id||r.currency!=='jpy'||r.amount!==p.amount_jpy
 ||!['succeeded','pending','requires_action','failed','canceled'].includes(r.status))throw new RefundReview('refund_identity_or_amount_mismatch');
 return {refund_id:r.id,refund_status:r.status,refund_amount_jpy:r.amount,refund_currency:r.currency,refund_charge_id:ref(r.charge),refund_payment_intent_id:ref(r.payment_intent),failure_balance_transaction:ref(r.failure_balance_transaction)||null,failure_reason:typeof r.failure_reason==='string'?r.failure_reason:null};
}
export function frozenRefundParameters(p){return {payment_intent:p.stripe_payment_intent_id,reverse_transfer:'true',...(p.platform_fee_jpy>0?{refund_application_fee:'true'}:{})};}
export async function dispatchStripeRefund({db,stripe,paymentId,origin,actor=null,jobId=null,lease=null,live,platformId,now=()=>new Date().toISOString()}){
 if(!id(platformId,'acct')||typeof live!=='boolean')throw new RefundReview('refund_configuration_unavailable');
 const args={payment_id:paymentId,origin,actor,job_id:jobId,lease,platform_id:platformId,live};
 const op=await rpc(db,'prepare_stripe_refund',args),p=op.payment;
 if(!p||!op.id)throw new RefundReview('refund_operation_unavailable');
 let observation=null,refund=null,code=null;
 try{
  // A blocked first attempt does not even consult Stripe. Existing dispatches can be read-only reconciled.
  if(op.state==='needs_review'&&!op.dispatched_at&&!op.refund_id)return {ok:true,operation_id:op.id,dispatch_state:op.state,status:'unknown',review_required:true,error_code:op.error_code,seller_recovery:'unverified'};
  const account=await stripe.get('account');if(account?.id!==platformId)throw new RefundReview('refund_platform_mismatch');
  async function readPayment(){const observed=now();const pi=await stripe.get('payment_intents/'+encodeURIComponent(p.stripe_payment_intent_id)+'?expand%5B%5D=latest_charge');
   const charge=typeof pi?.latest_charge==='string'?await stripe.get('charges/'+encodeURIComponent(pi.latest_charge)):pi?.latest_charge;
   return {...verifyRefundPayment(p,pi,charge,live),stripe_reconciled_at:observed};}
  observation=await readPayment();
  if(op.refund_id){refund=verifyRefundObject(await stripe.get('refunds/'+encodeURIComponent(op.refund_id)),p,op.refund_id);}
  else if(op.state==='prepared'){
   if(observation.disputed||observation.refunded||observation.refunded_amount_jpy!==0)throw new RefundReview('existing_dispute_or_refund_requires_review');
   // A pending/failed/foreign refund is not permission to create a replacement refund.
   const prior=await stripe.get('refunds?payment_intent='+encodeURIComponent(p.stripe_payment_intent_id)+'&limit=100');
   if(prior?.object!=='list'||prior.has_more!==false||!Array.isArray(prior.data)||prior.data.length!==0)throw new RefundReview('existing_refund_history_requires_review');
   const parameters=frozenRefundParameters(p);
   // Last awaited operation before POST. SQL rechecks channel, hold, immutable bindings,
   // auto cancellation/lease and permanent one-shot state under the payment lock.
   const claim=await rpc(db,'claim_stripe_refund_dispatch',{...args,operation_id:op.id,parameters,observation});
   if(!claim.dispatch_granted)return {ok:true,operation_id:op.id,dispatch_state:claim.state,status:'unknown',review_required:true,error_code:claim.error_code||'dispatch_already_claimed',seller_recovery:'unverified'};
   let response;
   try{response=await stripe.postRefund(parameters,claim.idempotency_key);}
   catch{throw new RefundReview('provider_refund_result_unknown');}
   if(!response.ok)throw new RefundReview(response.body?.error?.type==='idempotency_error'?'provider_parameter_conflict':'provider_refund_rejected_or_unknown');
   refund=verifyRefundObject(response.body,p);
   // Save the verified identity before another network read; a lost follow-up cannot lose a known refund ID.
   await rpc(db,'record_stripe_refund_outcome',{operation_id:op.id,evidence:{...refund,observation,error_code:'post_refund_observation_pending'}});
   observation=await readPayment();
  }else{code='dispatch_result_requires_reconciliation';}
 }catch(error){code=error instanceof RefundReview?error.code:'refund_evidence_unavailable';}
 const result=await rpc(db,'record_stripe_refund_outcome',{operation_id:op.id,evidence:{...refund,observation,error_code:code}});
 return {ok:true,operation_id:op.id,dispatch_state:result.state,refund_id:result.refund_id,status:result.refund_status||'unknown',review_required:result.state!=='succeeded'&&result.state!=='pending',error_code:result.error_code,seller_recovery:'unverified',historical_refund_review:result.historical_refund_review===true,buyer_refund_verified:result.buyer_refund_verified===true};
}
export function stripeRefundTransport(key,fetcher=fetch){
 const headers={Authorization:`Bearer ${key}`,'Stripe-Version':'2026-09-30.endive'};
 return {get:async path=>{const r=await fetcher('https://api.stripe.com/v1/'+path,{headers,signal:AbortSignal.timeout(8000),redirect:'error'});if(!r.ok)throw new RefundReview('provider_read_unavailable');return r.json();},
 postRefund:async(parameters,idempotencyKey)=>{const r=await fetcher('https://api.stripe.com/v1/refunds',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':idempotencyKey},body:new URLSearchParams(parameters).toString(),signal:AbortSignal.timeout(8000),redirect:'error'});return {ok:r.ok,body:await r.json().catch(()=>null)};}};
}

// Read-only reconciliation for a known refund operation. No dispatch gate, lease or POST is involved.
export async function reconcileStripeRefundEvent({event,db,stripe,live,platformId,now=()=>new Date().toISOString()}){
 const r=event?.data?.object;
 if(!['refund.created','refund.updated','refund.failed'].includes(event?.type)||event.account!=null||event.context!=null
 ||event.livemode!==live||!id(r?.id,'re')||!id(ref(r.payment_intent),'pi'))throw new RefundReview('refund_event_scope_mismatch');
 const op=await rpc(db,'get_stripe_refund_operation',{refund_id:r.id,intent_id:ref(r.payment_intent),live});
 if(!op)return false;
 if(!id(platformId,'acct')||op.platform_id!==platformId||(await stripe.get('account'))?.id!==platformId)throw new RefundReview('refund_platform_mismatch');
 const observed=now(),p=op.payment;
 const pi=await stripe.get('payment_intents/'+encodeURIComponent(p.stripe_payment_intent_id)+'?expand%5B%5D=latest_charge');
 const charge=typeof pi?.latest_charge==='string'?await stripe.get('charges/'+encodeURIComponent(pi.latest_charge)):pi?.latest_charge;
 const observation={...verifyRefundPayment(p,pi,charge,live),stripe_reconciled_at:observed};
 const refund=verifyRefundObject(await stripe.get('refunds/'+encodeURIComponent(op.refund_id)),p,op.refund_id);
 const eventRefund=verifyRefundObject(r,p,op.refund_id);
 const conflict=eventRefund.refund_status!==refund.refund_status
  ||eventRefund.failure_balance_transaction!==refund.failure_balance_transaction||eventRefund.failure_reason!==refund.failure_reason;
 await rpc(db,'record_stripe_refund_outcome',{operation_id:op.id,evidence:{...refund,observation,
 verified_event:{event_id:event.id||null,event_type:event.type,event_created:event.created||null,livemode:live,...eventRefund},
 event_current_conflict:conflict,error_code:conflict?'refund_event_current_conflict':null}});
 return true;
}
