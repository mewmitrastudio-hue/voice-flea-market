import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReceipt,cancelReceiptAuthorization} from '../supabase/functions/_shared/receipt-capture.mjs';
const base={id:'payment',status:'authorized',stripe_payment_intent_id:'pi_test',stripe_charge_id:'ch_test',stripe_livemode:false,
  stripe_capture_method:'manual',stripe_destination:'acct_seller',amount_jpy:1000,platform_fee_jpy:150,seller_amount_jpy:850};
function fixture({payment={},pi={},charge={},captureError=false,readError=false,after={}}={}){
 const calls=[];let captured=false;
 const provider=()=>({id:'pi_test',livemode:false,currency:'jpy',amount:1000,capture_method:'manual',application_fee_amount:150,
   transfer_data:{destination:'acct_seller'},status:captured?'succeeded':'requires_capture',amount_capturable:captured?0:1000,...pi,
   latest_charge:{id:'ch_test',payment_intent:'pi_test',livemode:false,currency:'jpy',amount:1000,paid:true,amount_refunded:0,
    captured,amount_captured:captured?1000:0,transfer:captured?'tr_test':null,payment_method_details:{card:{capture_before:2000000000}},...charge,...(captured?after:{})}});
 const stripe={get:async path=>{calls.push('get');if(captured&&readError)throw Error('read unknown');return path.startsWith('transfers/')?{id:'tr_test',livemode:false,currency:'jpy',amount:1000,destination:'acct_seller',source_transaction:'ch_test',reversed:false,amount_reversed:0}:provider();},capture:async(...args)=>{calls.push(args);captured=true;if(captureError)throw Error('capture unknown');}};
 return {calls,stripe,payment:{...base,...payment}};
}
test('receipt capture verifies exact amount, destination and post-capture transfer before returning evidence',async()=>{
 const f=fixture();const result=await captureReceipt({...f,live:false,now:()=>1800000000000});
 assert.equal(result.transfer_id,'tr_test');assert.equal(result.amount_jpy,1000);
 assert.deepEqual(f.calls,['get',['pi_test',{amount_to_capture:1000},'receipt-capture:payment'],'get','get']);
});
test('wrong buyer payment evidence, price, mode, destination, fee or expired authorization never captures',async()=>{
 for(const overrides of [{pi:{id:'pi_other'}},{pi:{amount:1100}},{pi:{livemode:true}},{pi:{currency:'usd'}},
   {charge:{payment_intent:'pi_other'}},{charge:{amount_refunded:1}},{charge:{paid:false}},
   {pi:{transfer_data:{destination:'acct_other'}}},{pi:{application_fee_amount:100}},
   {pi:{capture_method:'automatic'}},{pi:{amount_capturable:900}},
   {charge:{payment_method_details:{card:{capture_before:1}}}},{charge:{payment_method_details:{}}}]){
  const f=fixture(overrides);await assert.rejects(captureReceipt({...f,live:false}));assert.deepEqual(f.calls,['get']);
 }
});
test('unknown capture results are not reported accepted; retry reconciles the already captured intent without recapturing',async()=>{
 const f=fixture({captureError:true});await assert.rejects(captureReceipt({...f,live:false}),/unknown/);
 const result=await captureReceipt({...f,live:false});assert.equal(result.transfer_id,'tr_test');assert.equal(f.calls.filter(Array.isArray).length,1);
});
test('missing transfer, refund after capture, or failed authoritative read cannot complete receipt acceptance',async()=>{
 for(const options of [{after:{transfer:null}},{after:{amount_refunded:1000}},{readError:true}]){
  const f=fixture(options);await assert.rejects(captureReceipt({...f,live:false}));
 }
});
test('legacy captured payments are checked without another capture and do not invent a transfer',async()=>{
 const f=fixture({payment:{status:'paid',stripe_capture_method:'automatic'},pi:{status:'succeeded'},charge:{captured:true,amount_captured:1000}});
 const r=await captureReceipt({...f,live:false});assert.equal(r.transfer_id,null);assert.deepEqual(f.calls,['get']);
});

test('cancellation waits for Stripe to confirm release and uses the same durable key on retries',async()=>{
 let status='requires_capture',calls=[];
 const stripe={get:async()=>({...base,id:'pi_test',status,livemode:false,currency:'jpy',amount:1000,capture_method:'manual',transfer_data:{destination:'acct_seller'},application_fee_amount:150}),cancel:async(...args)=>{calls.push(args);status='canceled';}};
 const result=await cancelReceiptAuthorization({payment:base,stripe,live:false});assert.equal(result.canceled,true);
 await cancelReceiptAuthorization({payment:base,stripe,live:false});assert.deepEqual(calls,[['pi_test',{},'authorization-cancel:payment']]);
 status='succeeded';await assert.rejects(cancelReceiptAuthorization({payment:base,stripe,live:false}),/unconfirmed/);assert.equal(calls.length,1);
});
