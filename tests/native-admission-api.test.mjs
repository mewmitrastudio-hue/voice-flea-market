import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {guardedAdmissionDatabase} from './fixtures/admission-guarded-database.mjs';
import {admissionDatabase} from './fixtures/admission-database.mjs';
import {validRequest,canonicalResponse} from '../supabase/functions/_shared/native-admission-contract.mjs';
import {purchaseEnvironments,preparationEnvironment,recipientEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000003';
const order='00000000-0000-4000-8000-000000000005',fresh='00000000-0000-4000-8000-000000000006';
const draft=fs.readFileSync(new URL('./fixtures/native-admission-70000.sql',import.meta.url),'utf8');
async function fixture({enabled=false,staged=false,blank=false,environment='Sandbox',stripeKey='sk_test_synthetic',recipientFailure=false,defaultServiceGrant=false}={}){
 const db=staged?await guardedAdmissionDatabase():await admissionDatabase();
 if(defaultServiceGrant)await db.exec('alter default privileges in schema public grant execute on functions to service_role');
 // TEST ONLY: staged tests remove the build hold from a separate in-memory DB.
 // Candidate source retains the unconditional hold. 60000 fixture is unaudited.
 await db.exec(staged?draft.replace("if requested_action in ('prepareInitial','begin','prepareRetry') then raise exception 'recovery_not_enabled'; end if;",''):draft);
 if(staged&&!blank)await db.query('select prepare_voice_iap_order($1,$2,$3,$4)',[owner,'00000000-0000-4000-8000-000000000004',order,'Sandbox']);
 const a=blank?{}:(await db.query('select native_retry_admission($1,$2,$3) r',[owner,'register',order])).rows[0].r;
 let handler;const calls=[];
 const rpc=async(name,args)=>{
  calls.push({name,args});
  try {return {data:(await db.query(`select public.${name}(${Object.keys(args).map((k,i)=>`${k}=>$${i+1}`).join(',')}) r`,Object.values(args))).rows[0].r};}catch(e){return {error:{message:e.message}};}
 };
 const admin={from:table=>({select(){return this;},eq(k,v){this.key=k;this.value=v;return this;},async maybeSingle(){try{return {data:(await db.query(`select * from public.${table} where ${this.key}=$1`,[this.value])).rows[0]};}catch{return {error:{}};}}}),auth:{getUser:async token=>({data:{user:['valid','foreign'].includes(token)?{id:token==='valid'?owner:other}:null}})},rpc};
 const c={validRequest,canonicalResponse,purchaseEnvironments,preparationEnvironment,recipientEnvironment,Response,Request,Uint8Array,TextDecoder,JSON,console,Deno:{env:{get:n=>({SUPABASE_URL:'https://tyulybijubckitybgubc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',NATIVE_PURCHASE_RECOVERY_V3_ENABLED:enabled?'true':'false',VOICE_IAP_ENABLED:'true',BOOST_IAP_ENABLED:'true',BOOST_IAP_ENVIRONMENT:environment,VOICE_IAP_ENVIRONMENT:environment,STRIPE_SECRET_KEY:stripeKey})[n]},serve:f=>handler=f},createClient:()=>admin,Stripe:function(){},appleConfig(){},requireRecipient:async()=>{if(recipientFailure)throw Error('synthetic recipient failure');}};
 vm.createContext(c);vm.runInContext(stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/native-purchases/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')),c);
 const send=(body,token='valid')=>handler(new Request('https://tyulybijubckitybgubc.supabase.co/functions/v1/native-purchases',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:typeof body==='string'?body:JSON.stringify(body)}));
 const request=action=>({version:3,action,orderId:order,attemptNonce:a.attemptNonce});
 return {db,a,send,request,calls,rpc};
}
test('actual Edge and SQL authenticate and isolate owner/nonce',async()=>{
 const f=await fixture();try{
  for(const token of [null,'expired'])assert.equal((await f.send(f.request('status'),token)).status,401);
  assert.equal((await f.send(f.request('status'),'foreign')).status,403);
  assert.equal((await f.send({...f.request('status'),attemptNonce:fresh})).status,403);
  const r=await f.send(f.request('status'));assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'no-store');
  const b=await r.json();assert.equal(b.ownerId,owner);assert.equal(b.attempt.orderId,order);assert.equal(b.attempt.amountJpy,1000);assert.equal(b.attempt.previousOrderId,null);assert.equal(b.launchGranted,false);
 }finally{await f.db.close();}
});
test('all new admission remains disabled even if the Edge flag is accidentally enabled',async()=>{
 for(const enabled of [false,true]){const f=await fixture({enabled});try{
  const r=await f.send(f.request('begin'));assert.equal(r.status,503);assert.equal((await r.json()).code,'recovery_not_enabled');
  assert.equal((await f.send(f.request('status'))).status,200);
  assert.equal((await f.db.query('select admission_state from voice_flea_private.native_retry_attempts')).rows[0].admission_state,'prepared');
 }finally{await f.db.close();}}
});
test('unknown actions/authority fields and streaming oversize never touch SQL',async()=>{
 const f=await fixture();try{
  for(const key of ['actorId','ownerId','backendProjectRef','amount','currency','environment','productId','signedTransaction'])assert.equal((await f.send({...f.request('status'),[key]:'injected'})).status,400);
  assert.equal((await f.send({...f.request('status'),action:'finishAck'})).status,400);
  assert.equal((await f.send('x'.repeat(8193))).status,400);assert.equal(f.calls.length,0);
 }finally{await f.db.close();}
});
test('cancel report returns actual state atomically, never money or clearing a newer attempt',async()=>{
 const f=await fixture();try{
  await f.db.query('select native_retry_admission($1,$2,$3,$4)',[owner,'begin',order,f.a.attemptNonce]);
  const c=await (await f.send(f.request('cancelReport'))).json();assert.equal(c.attempt.state,'client_reported_cancelled');assert.equal(c.launchGranted,false);
  await f.db.query('select native_retry_admission($1,$2,$3,$4,$5)',[owner,'retry',order,f.a.attemptNonce,fresh]);
  const again=await (await f.send(f.request('cancelReport'))).json();assert.equal(again.attempt.state,'retired');
  assert.equal((await f.db.query('select admission_state from voice_flea_private.native_retry_attempts where order_id=$1',[fresh])).rows[0].admission_state,'prepared');
  await f.db.query("update voice_flea_private.native_retry_attempts set admission_state='transaction_observed' where order_id=$1",[order]);
  assert.equal((await (await f.send(f.request('cancelReport'))).json()).attempt.state,'transaction_observed');
  assert.equal((await f.db.query('select count(*)::int n from payments')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('pending approval cannot become client cancellation',async()=>{
 const f=await fixture();try{
  await f.db.query('select native_retry_admission($1,$2,$3,$4)',[owner,'begin',order,f.a.attemptNonce]);
  assert.equal((await (await f.send(f.request('pendingReport'))).json()).attempt.state,'pending_approval');
  const r=await f.send(f.request('cancelReport'));assert.equal(r.status,409);assert.equal((await r.json()).code,'purchase_state_conflict');
 }finally{await f.db.close();}
});
test('bounded stable keyset listing and no cross-owner data',async()=>{
 const f=await fixture();try{
  await f.db.query("update voice_flea_private.native_retry_attempts set admission_state='transaction_observed'");
  await f.db.query("insert into voice_flea_private.native_retry_attempts(order_id,previous_order_id,intent_id,owner_id,nonce,product_id,amount_jpy,environment,admission_state,created_at) select $1,order_id,intent_id,owner_id,gen_random_uuid(),product_id,amount_jpy,environment,'transaction_observed',created_at from voice_flea_private.native_retry_attempts where order_id=$2",[fresh,order]);
  const first=await(await f.send({version:3,action:'listAttempts',pageSize:1})).json();assert.equal(first.attempts.length,1);assert.equal(first.attempts[0].orderId,order);assert.equal(first.nextCursor.orderId,order);
  const second=await(await f.send({version:3,action:'listAttempts',pageSize:1,cursor:first.nextCursor})).json();assert.equal(second.attempts[0].orderId,fresh);assert.equal(second.nextCursor,null);
  const foreign=await(await f.send({version:3,action:'listAttempts'},'foreign')).json();assert.deepEqual(foreign.attempts,[]);
  assert.doesNotMatch(JSON.stringify(first),/signed_transaction|signedTransaction|sellerId/);
  for(const pageSize of [null,0,101,1.1,'1'])assert.equal((await f.send({version:3,action:'listAttempts',pageSize})).status,400);
  for(const cursor of [null,{}, {createdAt:first.nextCursor.createdAt},{orderId:order}])assert.equal((await f.send({version:3,action:'listAttempts',cursor})).status,400);
  await assert.rejects(f.db.query('select native_purchase_list_attempts($1,null)',[owner]),/purchase_state_conflict/);
 }finally{await f.db.close();}
});
test('new RPCs are service only, empty search_path, with read rate bound',async()=>{
 const f=await fixture();try{
  const p=(await f.db.query("select proname,has_function_privilege('authenticated',oid,'execute') allowed,proconfig from pg_proc where proname in ('native_purchase_admission','native_purchase_list_attempts','native_purchase_context')")).rows;
  assert.equal(p.length,3);for(const row of p){assert.equal(row.allowed,false);assert.deepEqual(row.proconfig,['search_path=""']);}
  await f.db.query("insert into voice_flea_private.native_admission_rate values($1,'read',clock_timestamp(),120)",[owner]);
  assert.equal((await f.send(f.request('status'))).status,503);
 }finally{await f.db.close();}
});
test('malformed database success cannot invent a permit or erase unknown listing',()=>{
 assert.equal(canonicalResponse({launchGranted:false},{action:'listAttempts'},owner),null);
 assert.equal(canonicalResponse({attempts:[],launchGranted:false},{action:'listAttempts'},owner),null);
 assert.equal(canonicalResponse({attempts:[],nextCursor:null,launchGranted:true},{action:'listAttempts'},owner),null);
 assert.equal(validRequest({version:3,action:'prepareInitial',kind:'voice_listing',subjectId:order,freshOrderId:fresh,boostPlan:'gold'}),false);
});
const subject='00000000-0000-4000-8000-000000000004';
for(const kind of ['voice_listing','voice_job','boost'])test(`TEST-ONLY ungated candidate + unaudited 60000: atomic ${kind} exact identity, response replay and begin single permit`,async()=>{
 const f=await fixture({enabled:true,staged:true,blank:true});try{
  let subjectId=kind==='boost'?'00000000-0000-4000-8000-000000000008':subject;
  if(kind==='voice_job'){
   await f.db.query("insert into jobs(id,buyer_id,title,budget_jpy) values($1,$2,'Job',1000)",[subject,owner]);
   await f.db.query("insert into applications(id,job_id,applicant_id,status,proposed_price_jpy) values($1,$2,'00000000-0000-4000-8000-000000000002','pending',1000)",[fresh,subject]);await f.db.query("update applications set status='accepted' where id=$1",[fresh]);subjectId=fresh;
  }
  const body={version:3,action:'prepareInitial',kind,subjectId,freshOrderId:order,...(kind==='boost'?{boostPlan:'silver'}:{})};
  const response=await f.send(body);const initial=await response.json();assert.equal(response.status,200,JSON.stringify(initial));assert.equal(initial.attempt.orderId,order);assert.equal(initial.launchGranted,false);
  const replay=await(await f.send(body)).json();assert.deepEqual(replay,initial);
  const begun={version:3,action:'begin',orderId:order,attemptNonce:initial.attempt.attemptNonce};
  const first=await(await f.send(begun)).json();assert.equal(first.launchGranted,true);assert.equal(first.attempt.state,'dispatch_unknown');
  const again=await(await f.send(begun)).json();assert.equal(again.launchGranted,false);
  const cancel=await(await f.send({...begun,action:'cancelReport'})).json();assert.equal(cancel.attempt.state,'client_reported_cancelled');
  const freshOrderId='00000000-0000-4000-8000-000000000009';
  const retry={...begun,action:'prepareRetry',freshOrderId};
  const next=await(await f.send(retry)).json();assert.equal(next.attempt.orderId,freshOrderId);assert.equal(next.attempt.previousOrderId,order);assert.equal(next.attempt.intentId,initial.attempt.intentId);assert.equal(next.launchGranted,false);
  assert.deepEqual(await(await f.send(retry)).json(),next);
  const wrong=await f.send({...retry,freshOrderId:'00000000-0000-4000-8000-000000000010'});assert.equal(wrong.status,409);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: seller snapshot mismatch and registration failure rollback the entire initial order',async()=>{
 const f=await fixture({staged:true,enabled:true,blank:true});try{
  const params={actor:owner,requested_action:'prepareInitial',fresh_order:order,requested_kind:'voice_listing',subject,tx_environment:'Sandbox',expected_seller:other,voice_environments:['Sandbox']};
  const result=await f.rpc('native_purchase_admission',params);assert.equal(result.error.message,'quote_changed');
  assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,0);
  assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,0);
  await f.db.exec("create function voice_flea_private.reject_test_registration() returns trigger language plpgsql as $$begin raise exception 'synthetic register failure';end$$;create trigger reject_registration before insert on voice_flea_private.native_retry_attempts for each row execute function voice_flea_private.reject_test_registration()");
  const r=await f.send({version:3,action:'prepareInitial',kind:'voice_listing',subjectId:subject,freshOrderId:order});assert.equal(r.status,503);
  assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: existing legacy order is not adopted, and historical payment blocks atomic registration',async()=>{
 const f=await fixture({staged:true,enabled:true,blank:true});try{
  await f.db.query('select prepare_voice_iap_order($1,$2,$3,$4)',[owner,subject,order,'Sandbox']);
  const initial={version:3,action:'prepareInitial',kind:'voice_listing',subjectId:subject,freshOrderId:fresh};
  let r=await f.send(initial);assert.equal(r.status,409);assert.equal((await r.json()).code,'legacy_reconciliation_required');
  assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,0);
  r=await f.send({...initial,freshOrderId:order});assert.equal(r.status,409);
  await f.db.query('delete from voice_flea_private.voice_iap_orders');
  await f.db.query("insert into payments(listing_id,buyer_id,seller_id,amount_jpy,status) values($1,$2,'00000000-0000-4000-8000-000000000002',1000,'paid')",[subject,owner]);
  r=await f.send(initial);assert.equal(r.status,409);assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: legacy refund purpose hold blocks begin, leaves status/reports available and no launch',async()=>{
 const f=await fixture({staged:true,enabled:true});try{
  await f.db.query("insert into voice_flea_private.legacy_apple_refund_reviews(environment,transaction_id,order_id,order_kind,owner_id,subject_id,product_id,amount_jpy,purchased_at,classification) values('Sandbox','123',$1,'voice_listing',$2,$3,'com.ayuhide.koenofurima.voice.jpy1000',1000,now(),'unfulfilled_review')",[fresh,owner,subject]);
  const r=await f.send(f.request('begin'));assert.equal(r.status,409);assert.equal((await r.json()).code,'review_required');
  assert.equal((await(await f.send(f.request('status'))).json()).attempt.state,'prepared');
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: frozen price and server environment cannot silently change',async()=>{
 const f=await fixture({staged:true,enabled:true});try{
  await f.db.query('update listings set price_jpy=2000 where id=$1',[subject]);
  const r=await f.send(f.request('begin'));assert.equal(r.status,409);assert.equal((await r.json()).code,'quote_changed');
  await f.db.query('update listings set price_jpy=1000 where id=$1',[subject]);
  const denied=await f.rpc('native_purchase_admission',{actor:owner,requested_action:'begin',requested_order:order,requested_nonce:f.a.attemptNonce,tx_environment:'Sandbox',expected_seller:'00000000-0000-4000-8000-000000000002',voice_environments:['Production']});assert.equal(denied.error.message,'purchase_state_conflict');
  assert.equal((await(await f.send(f.request('status'))).json()).attempt.state,'prepared');
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: active boost cannot create a fresh attempt',async()=>{
 const f=await fixture({staged:true,enabled:true,blank:true});try{
  const listingId='00000000-0000-4000-8000-000000000008';
  await f.db.query("insert into listing_boosts(listing_id,seller_id,status,environment,ends_at) values($1,$2,'active','Sandbox',now()+interval '1 day')",[listingId,owner]);
  const r=await f.send({version:3,action:'prepareInitial',kind:'boost',subjectId:listingId,freshOrderId:order,boostPlan:'silver'});assert.equal(r.status,409);assert.equal((await r.json()).code,'already_fulfilled');
  assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.boost_orders')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: Dual explicit hints use LIVE recipient mode; absent hint and wrong Stripe mode do not reserve',async()=>{
 const f=await fixture({staged:true,enabled:true,blank:true,environment:'Dual',stripeKey:'sk_live_synthetic'});try{
  const body={version:3,action:'prepareInitial',kind:'voice_listing',subjectId:subject,freshOrderId:order};
  assert.equal((await f.send(body)).status,409);
  const r=await f.send({...body,storeKitEnvironment:'Sandbox'});assert.equal(r.status,200);assert.equal((await r.json()).attempt.environment,'Sandbox');
 }finally{await f.db.close();}
 for(const options of [{environment:'Dual',stripeKey:'sk_test_synthetic'}, {recipientFailure:true}]){
  const f=await fixture({staged:true,enabled:true,blank:true,...options});try{
   assert.equal((await f.send({version:3,action:'prepareInitial',kind:'voice_listing',subjectId:subject,freshOrderId:order,storeKitEnvironment:'Sandbox'})).status,409);
   assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,0);
  }finally{await f.db.close();}
 }
});
test('Boost exact-ID helper revokes inherited service-role default EXECUTE grants',async()=>{
 const f=await fixture({staged:true,enabled:true,blank:true,defaultServiceGrant:true});try{
  const privilege=(await f.db.query("select has_function_privilege('service_role','public.prepare_boost_order_in_environment(uuid,uuid,text,text,uuid)','execute') allowed")).rows[0];assert.equal(privilege.allowed,false);
  await f.db.exec('set role service_role');
  await assert.rejects(f.db.query("select public.prepare_boost_order_in_environment($1,$2,'silver','Sandbox',$3)",[owner,'00000000-0000-4000-8000-000000000008',order]),/permission denied/);
  await f.db.exec('reset role');assert.equal((await f.db.query('select count(*)::int n from voice_flea_private.boost_orders')).rows[0].n,0);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: old ambiguous refund observation blocks prepared child launch across the whole intent',async()=>{
 const f=await fixture({staged:true,enabled:true});try{
  assert.equal((await f.send(f.request('begin'))).status,200);await f.send(f.request('cancelReport'));
  const next=(await(await f.send({...f.request('prepareRetry'),freshOrderId:fresh})).json()).attempt;
  const a=(await f.db.query('select * from voice_flea_private.native_retry_attempts where order_id=$1',[order])).rows[0];
  await f.db.query('select public.record_native_refund_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[order,'991',a.product_id,a.environment,a.created_at,a.amount_jpy*1000,'JPY',{refundEvidenceVersion:1,revocationType:'REFUND_PRORATED',revocationPercentage:50000},'synthetic-signed-partial',owner]);
  const child={version:3,orderId:fresh,attemptNonce:next.attemptNonce};
  const response=await f.send({...child,action:'begin'});assert.equal(response.status,409);assert.equal((await response.json()).code,'review_required');
  assert.equal((await(await f.send({...child,action:'status'})).json()).attempt.state,'prepared');
  assert.equal((await(await f.send(f.request('cancelReport'))).json()).attempt.state,'transaction_observed');
  assert.equal((await f.send({version:3,action:'listAttempts'})).status,200);
 }finally{await f.db.close();}
});
test('TEST-ONLY ungated: an unrevoked excess payment review on a sibling attempt blocks new launch',async()=>{
 const f=await fixture({staged:true,enabled:true});try{
  await f.send(f.request('begin'));await f.send(f.request('cancelReport'));
  const next=(await(await f.send({...f.request('prepareRetry'),freshOrderId:fresh})).json()).attempt;
  await f.db.query("insert into voice_flea_private.native_verified_receipts(environment,transaction_id,order_id,intent_id,owner_id,product_id,amount_jpy,purchased_at,classification,revoked,signed_transaction) select environment,'992',order_id,intent_id,owner_id,product_id,amount_jpy,created_at,'excess_payment_review',false,'synthetic-excess' from voice_flea_private.native_retry_attempts where order_id=$1",[order]);
  const r=await f.send({version:3,action:'begin',orderId:fresh,attemptNonce:next.attemptNonce});assert.equal(r.status,409);assert.equal((await r.json()).code,'review_required');
 }finally{await f.db.close();}
});
