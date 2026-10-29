import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {captureReceipt,cancelReceiptAuthorization,verifyReceiptPayment} from '../supabase/functions/_shared/receipt-capture.mjs';
import {createReceiptCheckout} from '../supabase/functions/_shared/receipt-checkout.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',trade='00000000-0000-4000-8000-000000000005';
const payment={id:'payment',status:'authorized',buyer_id:buyer,seller_id:seller,job_id:trade,job_application_id:trade,listing_id:null,payment_channel:'web',stripe_payment_intent_id:'pi_test',stripe_charge_id:'ch_test',stripe_livemode:false,stripe_capture_method:'manual',stripe_destination:'acct_seller',amount_jpy:1000,platform_fee_jpy:150,seller_amount_jpy:850};
function endpoint(slug,o={}){
 const calls=[];let handler,canceled=false;
 const env={SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',STRIPE_SECRET_KEY:'sk_test_unit'};
 const db={auth:{getUser:async()=>({data:{user:o.authFail?null:{id:buyer}}})},rpc:async(name,args)=>{
 calls.push({name,args});if(o.fail===name)return {error:true};return {data:name==='prepare_authorization_cancellation'?{payment,ready:o.ready!==false,state:'requested'}:name==='inspect_delivery_renewal'?{payment}:name==='prepare_voice_renewal_checkout'?{...payment,reservation_id:trade,title:'Fixed quote'}:null};}};
 function Stripe(){return {paymentIntents:{retrieve:async()=>{
 calls.push({name:'retrieve'});return {id:'pi_test',currency:'jpy',amount:1000,livemode:false,capture_method:'manual',application_fee_amount:150,transfer_data:{destination:'acct_seller'},status:canceled?'canceled':o.captured?'succeeded':'requires_capture',amount_capturable:1000,latest_charge:{id:'ch_test',payment_intent:'pi_test',currency:'jpy',amount:1000,amount_refunded:0,livemode:false,paid:true,captured:!!o.captured,amount_captured:o.captured?1000:0,transfer:o.captured?'tr_test':null,payment_method_details:{card:{capture_before:o.valid?2000000000:1000000000}}}};
 },cancel:async(id,params,options)=>{calls.push({name:'cancel',options});if(o.cancelUnknown)throw Error('unknown');canceled=true;},capture:()=>assert.fail('renewal must never capture a new payment')},
 transfers:{retrieve:async()=>({id:'tr_test',currency:'jpy',livemode:false,amount:1000,destination:'acct_seller',source_transaction:'ch_test',reversed:false,amount_reversed:0})},
 v2:{core:{accounts:{retrieve:async()=>({id:'acct_seller',livemode:false,configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{status:'active'}}}}},requirements:{entries:[]}})}}},
 checkout:{sessions:{create:async(params,options)=>{calls.push({name:'checkout',params,options});if(o.checkoutUnknown)throw Error('unknown');return {id:'cs_test_renewal',livemode:false,status:'open',url:'https://checkout.stripe.com/unit'};}}}};}
 const c={Request,Response,URL,Date,JSON,Number,String,Error,SyntaxError,console:{warn(){}},createClient:()=>db,Stripe,captureReceipt,cancelReceiptAuthorization,verifyReceiptPayment,createReceiptCheckout,Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn}};
 vm.runInNewContext(stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/'+slug+'/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'')),c);
 return {calls,send:()=>handler(new Request('https://local.invalid',{method:'POST',headers:{Authorization:'Bearer unit'},body:JSON.stringify({conversationId:trade,buyer_id:seller,amount:1})}))};
}
test('cancellation waits for both participants and persists only after an authoritative Stripe cancellation',async()=>{
 const waiting=endpoint('cancel-authorization',{ready:false});assert.equal((await waiting.send()).status,200);assert.deepEqual(waiting.calls.map(x=>x.name),['prepare_authorization_cancellation']);
 const e=endpoint('cancel-authorization');assert.equal((await e.send()).status,200);assert.equal(e.calls[0].args.actor,buyer);const names=e.calls.map(x=>x.name);assert.ok(names.indexOf('cancel')<names.indexOf('finish_authorization_cancellation'));assert.equal(e.calls.find(x=>x.name==='cancel').options.idempotencyKey,'authorization-cancel:payment');
 for(const o of [{cancelUnknown:true},{fail:'finish_authorization_cancellation'}])assert.equal((await endpoint('cancel-authorization',o).send()).status,503);
});
test('renewal refuses valid authorizations, preserves the original job quote and never captures twice',async()=>{
 const valid=endpoint('renew-authorization',{valid:true});assert.equal((await valid.send()).status,409);assert.equal(valid.calls.some(x=>x.name==='cancel'||x.name==='checkout'),false);
 const captured=endpoint('renew-authorization',{captured:true});const r=await captured.send();assert.equal(r.status,200);assert.equal((await r.json()).alreadyCaptured,true);assert.equal(captured.calls.some(x=>x.name==='checkout'||x.name==='cancel'),false);
 const e=endpoint('renew-authorization');const response=await e.send();assert.equal(response.status,200);assert.equal((await response.json()).applicationId,trade);assert.equal(e.calls.find(x=>x.name==='checkout').params.line_items[0].price_data.unit_amount,1000);assert.equal(e.calls.find(x=>x.name==='inspect_delivery_renewal').args.actor,buyer);
 const unknown=endpoint('renew-authorization',{checkoutUnknown:true});assert.equal((await unknown.send()).status,503);assert.equal(unknown.calls.some(x=>x.name==='finish_checkout_reservation'),false);
});
