import assert from 'node:assert/strict';
import {dbAdapter,buyer} from './refund-dispatch-database.mjs';
import {dispatchStripeRefund} from '../../supabase/functions/_shared/stripe-refund-dispatch.mjs';
export function provider(p,options={}){
 let refunded=0;const calls=[];let posts=0;
 const r={id:'re_unit',object:'refund',payment_intent:p.stripe_payment_intent_id,charge:p.stripe_charge_id,amount:p.amount_jpy,currency:'jpy',status:options.status||'succeeded',...options.refund};
 const stripe={get:async path=>{calls.push(path);if(path==='account')return {id:'acct_platform'};
 if(path.startsWith('payment_intents/'))return {object:'payment_intent',id:p.stripe_payment_intent_id,livemode:true,currency:'jpy',amount:p.amount_jpy,status:'succeeded',application_fee_amount:p.platform_fee_jpy,transfer_data:{destination:p.stripe_destination},metadata:{buyer_id:p.buyer_id,seller_id:p.seller_id,listing_id:p.listing_id},
 latest_charge:{object:'charge',id:p.stripe_charge_id,payment_intent:p.stripe_payment_intent_id,amount:p.amount_jpy,amount_captured:p.amount_jpy,paid:true,captured:true,disputed:false,refunded:refunded===p.amount_jpy,amount_refunded:refunded,livemode:true,currency:'jpy'},...options.pi};
 if(path.startsWith('refunds?')){if(options.beforeClaim)await options.beforeClaim();return {object:'list',has_more:false,data:options.existing||[]};}
 if(path==='refunds/re_unit')return r;throw Error('unexpected read');},
 postRefund:async(params,key)=>{posts++;assert.equal(key,'refund-payment-'+p.id);assert.deepEqual(params,{payment_intent:p.stripe_payment_intent_id,reverse_transfer:'true',refund_application_fee:'true'});
 if(options.holdDuringPost)await options.holdDuringPost();if(options.errorResponse)return {ok:false,body:options.errorResponse};
 refunded=options.refunded??(r.status==='succeeded'?p.amount_jpy:0);if(options.unknown)throw Error('network unknown');return {ok:true,body:r};}};
 return {stripe,calls,get posts(){return posts;},setRefunded:n=>refunded=n,setStatus:status=>r.status=status,setFailure:()=>{r.failure_balance_transaction='txn_returned';r.failure_reason='declined'}};
}
export const run=(db,p,f,extra={})=>dispatchStripeRefund({db:dbAdapter(db),stripe:f.stripe,paymentId:p.id,origin:'manual',actor:buyer,live:true,platformId:'acct_platform',...extra});
