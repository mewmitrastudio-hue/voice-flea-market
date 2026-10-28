import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {captureReceipt,ReceiptError} from '../supabase/functions/_shared/receipt-capture.mjs';
import {createReceiptCheckout} from '../supabase/functions/_shared/receipt-checkout.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004',trade='00000000-0000-4000-8000-000000000005',reservation='00000000-0000-4000-8000-000000000006';
const payment={id:'payment',buyer_id:buyer,seller_id:seller,listing_id:listing,status:'authorized',payment_channel:'web',stripe_payment_intent_id:'pi_test',stripe_charge_id:'ch_test',stripe_livemode:false,stripe_capture_method:'manual',stripe_destination:'acct_seller',amount_jpy:1000,platform_fee_jpy:150,seller_amount_jpy:850};
function endpoint(slug,options={}){
 const calls=[];let handler,captured=false;
 const env={SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only',STRIPE_SECRET_KEY:'sk_test_unit',STRIPE_RECEIPT_CAPTURE_ENABLED:options.enabled===false?'false':'true'};
 const conversation={id:trade,buyer_id:buyer,payment_id:'payment',delivery_status:'accepted'};
 const db={auth:{getUser:async()=>({data:{user:options.authFail?null:{id:buyer,email:'test@example.invalid'}},error:options.authFail?true:null})},
  from(table){return {select(){return this},eq(){return this},async maybeSingle(){return {data:table==='listings'?{id:listing,seller_id:seller,is_active:true,title:'Changed title',price_jpy:1500}:table==='applications'?{id:trade,job_id:listing,applicant_id:seller,status:'accepted',agreed_price_jpy:1000,agreed_at:'2026-10-29T00:00:00Z'}:table==='jobs'?{id:listing,buyer_id:buyer,status:'open',title:'Job'}:{id:seller,stripe_account_id:'acct_seller'}};} }},
  rpc:async(name,args)=>{calls.push({name,args});if(options.rpcFail===name)return {error:true};return {data:['prepare_voice_checkout','prepare_job_checkout'].includes(name)?{reservation_id:reservation,listing_id:options.job?null:listing,...options.job?{job_id:listing,job_application_id:trade}:{},buyer_id:buyer,seller_id:seller,stripe_destination:'acct_seller',amount_jpy:1000,title:'Frozen quote'}:name==='prepare_delivery_acceptance'?{payment:{...payment,...options.payment},conversation,alreadyAccepted:options.alreadyAccepted}:name==='finalize_delivery_acceptance'?conversation:null};}
 };
 function Stripe(){return {
  v2:{core:{accounts:{retrieve:async()=>({id:'acct_seller',livemode:false,configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{status:options.inactive?'inactive':'active'}}}}},requirements:{entries:[]}})}}},
  checkout:{sessions:{create:async(params,request)=>{calls.push({name:'checkout',params,request});if(options.providerUnknown)throw Error('unknown');return {id:'cs_test_1',livemode:false,url:'https://checkout.stripe.com/test'};}}},
  paymentIntents:{retrieve:async()=>{calls.push({name:'pi_get'});return {id:'pi_test',currency:'jpy',livemode:false,amount:1000,application_fee_amount:150,capture_method:'manual',transfer_data:{destination:'acct_seller'},status:captured?'succeeded':'requires_capture',amount_capturable:captured?0:1000,latest_charge:{id:'ch_test',payment_intent:'pi_test',currency:'jpy',livemode:false,amount:1000,amount_refunded:options.refunded?1000:0,paid:true,captured,amount_captured:captured?1000:0,transfer:captured?'tr_test':null,payment_method_details:{card:{capture_before:2000000000}}}};},capture:async(...args)=>{calls.push({name:'capture',args});captured=true;}},
  transfers:{retrieve:async()=>({id:'tr_test',currency:'jpy',livemode:false,amount:1000,destination:'acct_seller',source_transaction:'ch_test',reversed:false,amount_reversed:0})}
 };}
 const c={Response,Request,URL,Date,JSON,Number,String,Error,SyntaxError,Set,ReceiptError,captureReceipt,Stripe,
  createClient:()=>db,createReceiptCheckout,appleConfig:()=>({verifier:{verifiedTransactionById:async()=>{calls.push({name:'apple_get'});return {productId:'com.ayuhide.koenofurima.voice.jpy1000',currency:'JPY',price:1000000};}}}),
  applyTransaction:async()=>({paymentId:'payment',revoked:options.revoked}),console:{warn(){}},
  Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn}};
 const source=fs.readFileSync(new URL('../supabase/functions/'+slug+'/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
 vm.runInNewContext(stripTypeScriptTypes(source),c);
 return {calls,send:(body={},authenticated=true)=>handler(new Request('https://local.invalid/'+slug,{method:'POST',headers:authenticated?{Authorization:'Bearer test-token'}:{},body:JSON.stringify(body)}))};
}
test('Checkout uses a server frozen quote, manual card authorization and one durable idempotency key, ignoring client money and ownership',async()=>{
 const e=endpoint('create-checkout-session');const r=await e.send({listingId:listing,attemptId:trade,amount:1,buyer_id:seller,destination:'acct_attacker'});assert.equal(r.status,200);
 const call=e.calls.find(x=>x.name==='checkout');assert.equal(call.params.line_items[0].price_data.unit_amount,1000);assert.equal(call.params.line_items[0].price_data.product_data.name,'Frozen quote');
 assert.equal(call.params.payment_intent_data.capture_method,'manual');assert.equal(call.params.payment_intent_data.application_fee_amount,150);assert.equal(call.params.payment_intent_data.transfer_data.destination,'acct_seller');
 assert.equal(call.params.metadata.buyer_id,buyer);assert.equal(call.params.payment_intent_data.metadata.capture_flow,'receipt-v1');assert.deepEqual(Array.from(call.params.allowed_payment_method_types),['card']);assert.equal(call.request.idempotencyKey,'checkout:'+reservation);
 assert.equal(e.calls.some(x=>x.name==='capture'),false);
});
test('disabled sales, failed auth and inactive recipients cannot create a Checkout; uncertain outcomes retain their reservation',async()=>{
 for(const opts of [{enabled:false},{authFail:true},{inactive:true}]){const e=endpoint('create-checkout-session',opts);assert.ok((await e.send({listingId:listing,attemptId:trade})).status>=400);assert.equal(e.calls.some(x=>x.name==='checkout'),false);}
 const e=endpoint('create-checkout-session',{providerUnknown:true});assert.equal((await e.send({listingId:listing,attemptId:trade})).status,503);assert.equal(e.calls.some(x=>x.name==='finish_checkout_reservation'),false);
});
test('receipt endpoint captures only the authenticated buyers server-selected trade and finalizes after persisted evidence',async()=>{
 const e=endpoint('accept-delivery');assert.equal((await e.send({conversationId:trade,actor:seller,paymentId:'another',amount:1})).status,200);
 assert.equal(e.calls[0].args.actor,buyer);assert.equal(e.calls[0].args.trade_id,trade);
 const names=e.calls.map(x=>x.name);assert.ok(names.indexOf('capture')<names.indexOf('record_stripe_payment_snapshot'));assert.ok(names.indexOf('record_stripe_payment_snapshot')<names.indexOf('finalize_delivery_acceptance'));
});
test('unverified/refunded payments and persistence failures never report receipt success',async()=>{
 for(const options of [{refunded:true},{rpcFail:'prepare_delivery_acceptance'},{rpcFail:'record_stripe_payment_snapshot'},{rpcFail:'finalize_delivery_acceptance'}]){
  const e=endpoint('accept-delivery',options);assert.ok((await e.send({conversationId:trade})).status>=400);
  if(options.rpcFail!=='finalize_delivery_acceptance')assert.equal(e.calls.some(x=>x.name==='finalize_delivery_acceptance'),false);
 }
 const e=endpoint('accept-delivery');assert.equal((await e.send({conversationId:trade},false)).status,401);assert.equal(e.calls.length,0);
});
test('Apple receipt acceptance uses the latest verified transaction and revoked purchases cannot finish',async()=>{
 const e=endpoint('accept-delivery',{payment:{payment_channel:'ios',apple_transaction_id:'123',apple_environment:'Sandbox'},revoked:true});
 assert.equal((await e.send({conversationId:trade})).status,503);assert.ok(e.calls.some(x=>x.name==='apple_get'));assert.equal(e.calls.some(x=>x.name==='capture'||x.name==='finalize_delivery_acceptance'),false);
});

test('job Checkout uses only the accepted application and its immutable quote, never a client supplied seller or budget',async()=>{
 const e=endpoint('create-checkout-session',{job:true});assert.equal((await e.send({applicationId:trade,attemptId:reservation,amount:1,seller_id:'attacker'})).status,200);
 const prepare=e.calls.find(x=>x.name==='prepare_job_checkout');assert.equal(prepare.args.application,trade);assert.equal(prepare.args.actor,buyer);
 const checkout=e.calls.find(x=>x.name==='checkout');assert.equal(checkout.params.metadata.job_application_id,trade);assert.equal(checkout.params.metadata.job_id,listing);assert.equal(checkout.params.metadata.listing_id,undefined);assert.equal(checkout.params.line_items[0].price_data.unit_amount,1000);
 const invalid=endpoint('create-checkout-session',{job:true});assert.equal((await invalid.send({applicationId:trade,listingId:listing,attemptId:reservation})).status,400);
});
