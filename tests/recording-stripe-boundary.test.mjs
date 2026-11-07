import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {paymentDeployment,stripeWritesAllowed,stripeWriteBlocked} from '../supabase/functions/_shared/recording-stripe-boundary.mjs';
const recording='https://neotkrfsquysuatdruhg.supabase.co',production='https://tyulybijubckitybgubc.supabase.co';
const id='00000000-0000-4000-8000-000000000001';
function endpoint(slug,{url=recording,channel='web',enabled=true}={}){
 let handler;const calls=[];
 const payment={id:'payment',payment_channel:channel,apple_transaction_id:'123',apple_environment:'Sandbox',amount_jpy:1000};
 const conversation={id,delivery_status:'accepted'};
 const env={SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'unit',STRIPE_SECRET_KEY:'sk_live_unit',APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID:'acct_platform',
 STRIPE_RECEIPT_CAPTURE_ENABLED:String(enabled),APPLE_SETTLEMENT_TRANSFERS_ENABLED:String(enabled),APPLE_SETTLEMENT_FUNDING_APPROVED:String(enabled),APPLE_VOICE_SALES_ENABLED:String(enabled),APPLE_BOOST_SALES_ENABLED:String(enabled),RECORDING_APPLE_PAYMENTS_ENABLED:String(enabled),RECORDING_SALES_LOCKED:'false'};
 const db={auth:{getUser:async()=>({data:{user:{id:'buyer'}}})},
 from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{id,seller_id:'seller',stripe_account_id:'acct_seller',is_active:true,price_jpy:1000}})}),
 rpc:async(name)=>{calls.push(name);return {data:name==='finalize_delivery_acceptance'?conversation:name==='prepare_apple_settlement'?{id,payment_id:'payment'}:{payment,conversation,ready:true}};}};
 const c={Request,Response,URL,Uint8Array,TextDecoder,paymentDeployment,stripeWritesAllowed,stripeWriteBlocked,
 createClient:()=>{calls.push('database');return db;},Stripe:function(){calls.push('stripe');throw Error('provider sentinel');},
 fetch:async()=>{calls.push('fetch');throw Error('network prohibited');},
 appleConfig:()=>({verifier:{verifiedTransactionById:async()=>{calls.push('apple');return {productId:'com.ayuhide.koenofurima.voice.jpy1000',currency:'JPY',price:1000000};}}}),
 applyTransaction:async()=>{calls.push('applyApple');return {paymentId:'payment',revoked:false};},ReceiptError:class extends Error{},console:{warn(){}},
 Deno:{serve:f=>handler=f,env:{get:key=>env[key]}}};
 const source=fs.readFileSync(new URL('../supabase/functions/'+slug+'/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');
 vm.runInNewContext(stripTypeScriptTypes(source),c);
 return {calls,send:(action='dispatch',extra={})=>handler(new Request('https://request.invalid',{method:'POST',headers:{Authorization:'Bearer unit'},body:JSON.stringify({conversationId:id,paymentId:id,listingId:id,attemptId:id,action,...extra})}))};
}
test('only exact known production identity allows Stripe writes; unknown or malformed configuration fails closed',()=>{
 assert.equal(stripeWritesAllowed(production),true);assert.equal(stripeWritesAllowed(production+'/'),true);
 for(const url of [recording,undefined,null,'','https://local.invalid','http://tyulybijubckitybgubc.supabase.co',production+'.evil',production+'?enabled=true',production+'/functions',production+'#production','https://user@tyulybijubckitybgubc.supabase.co'])assert.equal(stripeWritesAllowed(url),false);
 assert.equal(paymentDeployment(recording),'recording');
});
for(const slug of ['create-checkout-session','renew-authorization','cancel-authorization','apple-settlement']){
 for(const enabled of [false,true])test(slug+' rejects recording before database, Stripe or fetch even with payment toggles '+enabled,async()=>{
  for(const action of slug==='apple-settlement'?['dispatch','recover','prepare','reconcile','reconcileRecovery']:['dispatch']){
   const e=endpoint(slug,{enabled}),r=await e.send(action);assert.equal(r.status,503);assert.equal((await r.json()).code,'stripe_writes_forbidden');assert.deepEqual(e.calls,[]);
  }
 });
 test(slug+' rejects missing or foreign environment before services',async()=>{
  for(const url of ['',null,'https://unknown.supabase.co']){const e=endpoint(slug,{url}),r=await e.send();assert.equal(r.status,503);assert.deepEqual(e.calls,[]);}
 });
 test(slug+' retains known production path',async()=>{
  const e=endpoint(slug,{url:production});await e.send();assert.ok(e.calls.includes('stripe'));assert.ok(e.calls.includes('database'));
 });
}
test('recording web capture rejects before Stripe even if request claims iOS and enables payments',async()=>{
 for(const enabled of [false,true]){
  const e=endpoint('accept-delivery',{channel:'web',enabled}),r=await e.send('dispatch',{payment_channel:'ios',channel:'ios'});
  assert.equal(r.status,503);assert.equal((await r.json()).code,'stripe_writes_forbidden');assert.deepEqual(e.calls,['database','prepare_delivery_acceptance']);
 }
});
test('trusted DB iOS receipt remains usable in recording without Stripe or fetch',async()=>{
 const e=endpoint('accept-delivery',{channel:'ios'}),r=await e.send();assert.equal(r.status,200);
 assert.equal((await r.json()).success,true);assert.deepEqual(e.calls,['database','prepare_delivery_acceptance','apple','applyApple','finalize_delivery_acceptance']);
});
test('unknown environment blocks iOS and web receipt before database or external calls',async()=>{
 for(const channel of ['ios','web'])for(const url of ['',null,'https://unknown.supabase.co']){
  const e=endpoint('accept-delivery',{url,channel}),r=await e.send();assert.equal(r.status,503);assert.deepEqual(e.calls,[]);
 }
});
test('known production web receipt reaches original Stripe branch',async()=>{
 const e=endpoint('accept-delivery',{url:production});await e.send();assert.ok(e.calls.includes('stripe'));
});
