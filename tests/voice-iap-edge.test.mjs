import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {preparationEnvironment,recipientEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
import {stripTypeScriptTypes} from 'node:module';
const user='00000000-0000-4000-8000-000000000001';
const listing='00000000-0000-4000-8000-000000000002';
const attempt='00000000-0000-4000-8000-000000000003';
function fixture({enabled=false,product='com.ayuhide.koenofurima.voice.jpy1000',applyFailure=false,stripeKey='sk_test_unit',environment='Sandbox',recipientFailure=false,foreignJob=false,changedSeller=false}={}){
 const calls=[],recipientCalls=[];let handler;
 const seller='00000000-0000-4000-8000-000000000004';
 const admin={from:table=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data:table==='applications'?{id:listing,job_id:listing,applicant_id:seller,status:'accepted'}:table==='jobs'?{id:listing,buyer_id:foreignJob?seller:user,status:'open'}:{id:listing,seller_id:seller,is_active:true}};}}),auth:{getUser:async token=>token==='valid'?{data:{user:{id:user}}}:{data:{user:null},error:{}}},rpc:async(name,args)=>{calls.push({name,args});return {data:{sellerId:changedSeller?user:seller,orderId:attempt,productId:product,amountJpy:1000,environment:'Sandbox',state:'prepared'}};}};
 const c={preparationEnvironment,recipientEnvironment,Response,Request,Uint8Array,TextDecoder,JSON,console:{error(){}},Deno:{env:{get:name=>({SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only',STRIPE_SECRET_KEY:stripeKey,VOICE_IAP_ENABLED:enabled?'true':'false',VOICE_IAP_ENVIRONMENT:environment})[name]},serve:fn=>handler=fn},
  createClient:()=>admin,Stripe:function(){},requireRecipient:async args=>{recipientCalls.push(args.sellerId);assert.equal(calls.length,0,'readiness precedes reservation');if(recipientFailure)throw Error('not ready');},appleConfig(){},verifiedTransaction:async()=>({productId:product,price:1000000,currency:'JPY'}),
  applyTransaction:async(db,tx,actor)=>{calls.push({actor,tx});if(applyFailure)throw Error(typeof applyFailure==='string'?applyFailure:'database unavailable');return {paymentId:'payment',conversationId:'trade'};}
 };
 const src=fs.readFileSync(new URL('../supabase/functions/voice-iap/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(src),c);
 const send=(body,token='valid')=>handler(new Request('https://edge.invalid',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:typeof body==='string'?body:JSON.stringify(body)}));
 return {calls,recipientCalls,send};
}
test('voice Edge authorizes the current buyer and reconciles paid receipts even with new sales off',async()=>{
 const f=fixture();assert.equal((await f.send({action:'verify'},null)).status,401);assert.equal((await f.send({action:'verify'},'invalid')).status,401);
 assert.equal((await f.send({action:'prepare',listingId:listing,attemptId:attempt})).status,409);assert.equal(f.calls.length,0);
 const r=await f.send({action:'verify',signedTransaction:'signed',actor:'attacker'});assert.equal(r.status,200);assert.equal((await r.json()).success,true);assert.equal(f.calls[0].actor,user);
});
test('voice Edge bounds the body and ignores client supplied owner, environment, price and SKU',async()=>{
 const f=fixture({enabled:true});assert.equal((await f.send('x'.repeat(35001))).status,413);assert.equal(f.calls.length,0);
 const r=await f.send({action:'prepare',listingId:listing,attemptId:attempt,owner_id:'attacker',tx_environment:'Production',price:1,sku:'cheap'});
 assert.equal(r.status,200);assert.equal(f.calls[0].name,'prepare_voice_iap_order');
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)),{owner_id:user,listing,attempt,tx_environment:'Sandbox'});
});
test('voice Edge rejects boost receipts and persistence failures never report a granted purchase',async()=>{
 const wrong=fixture({product:'com.ayuhide.koenofurima.boost.silver'});
 assert.equal((await wrong.send({action:'verify',signedTransaction:'signed'})).status,400);assert.equal(wrong.calls.length,0);
 const failed=fixture({applyFailure:true});const r=await failed.send({action:'verify',signedTransaction:'signed'});assert.equal(r.status,503);assert.equal((await r.json()).success,undefined);
});

test('Apple job prepare binds the authenticated job buyer and ignores client supplied price and seller',async()=>{
 const e=fixture({enabled:true});const r=await e.send({action:'prepareJob',applicationId:listing,attemptId:attempt,amount:1,seller_id:'attacker'});assert.equal(r.status,200);
 assert.equal(e.calls[0].name,'prepare_job_voice_iap_order');assert.equal(e.calls[0].args.owner_id,user);assert.equal(e.calls[0].args.application,listing);assert.equal(e.calls[0].args.tx_environment,'Sandbox');
});

for(const action of ['prepare','prepareJob']){
 test(`${action} rejects missing or mismatched payment configuration before reserving an order`,async()=>{
  for(const config of [{stripeKey:''},{stripeKey:'invalid'},{stripeKey:'sk_live_unit'},{stripeKey:'sk_test_unit',environment:'Production'}]){
   const f=fixture({enabled:true,...config});
   const r=await f.send({action,listingId:listing,applicationId:listing,attemptId:attempt});
   assert.equal(r.status,409);assert.equal(f.calls.length,0,'must not leave a prepared order');
  }
 });
}
test('paid receipt recovery remains available when the new purchase payment environment is missing',async()=>{
 const f=fixture({stripeKey:''});
 const r=await f.send({action:'verify',signedTransaction:'signed'});
 assert.equal(r.status,200);assert.equal((await r.json()).paymentId,'payment');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].actor,user);
});

for(const action of ['prepare','prepareJob']){
 test(`${action} leaves no reservation when the server-resolved seller cannot receive funds`,async()=>{
  const f=fixture({enabled:true,recipientFailure:true});
  const r=await f.send({action,listingId:listing,applicationId:listing,attemptId:attempt,sellerId:user});
  assert.equal(r.status,409);assert.equal((await r.json()).code,'seller_not_ready');
  assert.equal(f.calls.length,0);assert.deepEqual(f.recipientCalls,['00000000-0000-4000-8000-000000000004']);
 });
 test(`${action} refuses a quote whose seller changed after the readiness check`,async()=>{
  const f=fixture({enabled:true,changedSeller:true});
  const r=await f.send({action,listingId:listing,applicationId:listing,attemptId:attempt});
  assert.equal(r.status,409);assert.equal((await r.json()).orderId,undefined);
 });
}
test('a different job buyer cannot probe seller readiness or reserve an order',async()=>{
 const f=fixture({enabled:true,foreignJob:true});
 const r=await f.send({action:'prepareJob',applicationId:listing,attemptId:attempt});
 assert.equal(r.status,409);assert.equal(f.calls.length,0);assert.equal(f.recipientCalls.length,0);
});

test('a durably held refund returns actionable Japanese guidance, not purchase success',async()=>{
 const f=fixture({applyFailure:'APPLE_REFUND_REVIEW_HELD'});const r=await f.send({action:'verify',signedTransaction:'signed'});assert.equal(r.status,409);const body=await r.json();assert.equal(body.code,'apple_refund_review_required');assert.match(body.error,/運営へお問い合わせ/);assert.equal(body.success,undefined);
});

for(const action of ['prepare','prepareJob'])for(const storeKitEnvironment of ['Sandbox','Production']){
 test(`dual ${action} routes ${storeKitEnvironment} only to a prepared order, with the real seller check`,async()=>{
  const f=fixture({enabled:true,environment:'Dual',stripeKey:'sk_live_unit'});
  const r=await f.send({action,listingId:listing,applicationId:listing,attemptId:attempt,storeKitEnvironment,owner_id:'attacker',tx_environment:'Other',price:1});
  assert.equal(r.status,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.tx_environment,storeKitEnvironment);assert.equal(f.calls[0].args.owner_id,user);assert.equal(f.recipientCalls.length,1);
 });
}
test('dual preparation rejects missing or invented native environment without creating an order',async()=>{
 for(const hint of [undefined,'Xcode','Production ']){
  const f=fixture({enabled:true,environment:'Dual',stripeKey:'sk_live_unit'});
  const r=await f.send({action:'prepare',listingId:listing,attemptId:attempt,storeKitEnvironment:hint});
  assert.equal(r.status,409);assert.equal(f.calls.length,0);assert.equal(f.recipientCalls.length,0);
 }
});
