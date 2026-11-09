import {stripeDisputeEvents} from '../../supabase/functions/_shared/stripe-disputes.mjs';
export const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
export function fixture(){
 const d={id:'dp_test',object:'dispute',livemode:true,charge:'ch_test',payment_intent:'pi_test',currency:'jpy',amount:500,status:'needs_response',evidence_details:{due_by:1900000000}};
 const event={id:'evt_test',created:1800000000,type:stripeDisputeEvents[0],livemode:true,data:{object:{...d}}};
 const objects={account:{id:'acct_platform'},'disputes/dp_test':d,
 'charges/ch_test':{id:'ch_test',object:'charge',payment_intent:'pi_test',livemode:true,currency:'jpy',amount:1000,amount_captured:1000,amount_refunded:0,paid:true,captured:true,transfer:'tr_test'},
 'payment_intents/pi_test':{id:'pi_test',object:'payment_intent',latest_charge:'ch_test',livemode:true,currency:'jpy',amount:1000,transfer_data:{destination:'acct_seller'},metadata:{buyer_id:buyer,seller_id:seller,listing_id:listing}}};
 const calls=[];let snapshot;
 const f={event,objects,calls,platformId:'acct_platform',live:true,get:async p=>{calls.push(p);return objects[p]},db:{rpc:async(n,a)=>{calls.push(n);snapshot=a.snapshot;return {error:null}}}};
 return {...f,snapshot:()=>snapshot};
}
