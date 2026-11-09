import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {jobDatabase} from './fixtures/receipt-database.mjs';
import {createAppleAdapter} from '../supabase/functions/_shared/apple-adapter.mjs';
import {nativeAttempt} from '../supabase/functions/_shared/native-purchase-attempt.mjs';
import {nativePurchaseGrant} from '../supabase/functions/_shared/native-purchase-grant.mjs';
import {nativePurchaseReceipt} from '../supabase/functions/_shared/native-purchase-receipt.mjs';
import {purchaseEnvironments,preparationEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
import {captureReceipt,ReceiptError} from '../supabase/functions/_shared/receipt-capture.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
// Reuse the reviewed synthetic setup and actual SQL; never contact a provider.
const fixtureText=read('tests/native-retry-intents.test.mjs');
const setup=fixtureText.slice(fixtureText.indexOf('const owner='),fixtureText.indexOf("test('normal cancellation")).replace(/const read=n=>[^\n]+\n/,'');
const F=new Function('jobDatabase','read','assert',setup+';return {fixture,admission,cancelledRetry,owner,seller,listing,order,fresh,sku};')(jobDatabase,n=>read('supabase/migrations/'+n),assert);
// Credential-shaped values below are explicit synthetic placeholders, not account secrets.
// AQID decodes to only 3 bytes (01 02 03), not a PKCS8 key; crypto/provider calls are mocked.
const env={SUPABASE_URL:'https://tyulybijubckitybgubc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',BOOST_IAP_ENABLED:'true',VOICE_IAP_ENABLED:'true',BOOST_IAP_ENVIRONMENT:'Sandbox',VOICE_IAP_ENVIRONMENT:'Sandbox',APPLE_IAP_PRIVATE_KEY:'-----BEGIN PRIVATE KEY-----AQID-----END PRIVATE KEY-----',APPLE_IAP_ISSUER_ID:'synthetic',APPLE_IAP_KEY_ID:'synthetic',APPLE_VERIFIER_URL:'https://verifier.example.invalid/',APPLE_VERIFIER_SHARED_SECRET:'x'.repeat(32)};
function provider(transactions){
 const calls=[];const json=x=>({ok:true,json:async()=>JSON.parse(JSON.stringify(x))});
 const fetchImpl=async(url,opts={})=>{
  url=new URL(url);calls.push({host:url.hostname,path:url.pathname});
  if(url.hostname==='verifier.example.invalid'&&url.pathname==='/v1/transaction'){
   const signed=JSON.parse(opts.body).signedTransaction;const tx=transactions.get(signed);if(!tx)return {ok:false};return json({transaction:tx});
  }
  if(url.hostname==='verifier.example.invalid'&&url.pathname==='/v1/notification')return json({notification:{environment:'Sandbox',notificationType:'ONE_TIME_CHARGE',data:{signedTransactionInfo:JSON.parse(opts.body).signedPayload.replace('notice-','submitted-')}}});
  if(['api.storekit-sandbox.apple.com','api.storekit.apple.com'].includes(url.hostname))return json({signedTransactionInfo:'current-'+url.pathname.split('/').at(-1)});
  throw Error('Unexpected external target');
 };
 const cryptoImpl={subtle:{importKey:async()=>({}),sign:async()=>new Uint8Array(64)}};
 return {calls,fetchImpl,cryptoImpl};
}
function appleModule(p,overrides={}){
 const c=vm.createContext({Date,URL,Object,Number,Error,createAppleAdapter:opts=>createAppleAdapter({...opts,fetchImpl:p.fetchImpl,cryptoImpl:p.cryptoImpl}),Deno:{env:{get:k=>({...env,...overrides})[k]}}});
 vm.runInContext(stripTypeScriptTypes(read('supabase/functions/_shared/apple.ts').replace(/^import .*\n/gm,'').replace(/^export /gm,'')),c);
 return vm.runInContext('({appleConfig,verifiedTransaction,applyTransaction,enabled})',c);
}
const refundFixtureText=read('tests/native-refund-observations.test.mjs');
const refundSetup=refundFixtureText.slice(refundFixtureText.indexOf('const owner='),refundFixtureText.indexOf('for(const sameOrder')).replace(/const read=n=>[^\n]+\n/,'');
const R=new Function('jobDatabase','read','assert',refundSetup.replace("await args(db,'100');","if(register)await args(db,'100');")+';return {fixture};')(jobDatabase,n=>read('supabase/migrations/'+n),assert);
async function database(kind='voice',environment='Sandbox'){
 const db=await R.fixture(kind,environment,true);await db.exec(read('supabase/migrations/20261109050000_native_submitted_receipt_evidence.sql'));await db.exec(read('supabase/migrations/20261109060000_legacy_refund_observations.sql'));return db;
}
async function txFor(db,id,txid,kind='voice',extra={}){
 const row=(await db.query('select * from voice_flea_private.native_retry_attempts where order_id=$1',[id])).rows[0];
 return {transactionId:txid,appAccountToken:id,environment:row.environment,productId:row.product_id,price:row.amount_jpy*1000,currency:'JPY',purchaseDate:new Date(row.created_at).getTime(),type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED',...extra};
}
function adminFor(db,opts={}){
 const calls=[];const admin={auth:{getUser:async()=>({data:{user:opts.authFail?null:{id:opts.actor??F.owner}}})},
  rpc:async(name,args)=>{
   calls.push({name,args});if(opts.rpcHook){const response=await opts.rpcHook(name,args);if(response!==undefined)return response;}
   if(!/^[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^[a-z_]+$/.test(k)))throw Error('Unexpected RPC identifier');
   const keys=Object.keys(args),values=keys.map(k=>args[k]!==null&&typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
   try{return {data:(await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) r`,values)).rows[0].r};}catch(error){return {error:{message:error.message}};}
  }};return {admin,calls};
}
function endpoint(slug,{admin,apple,overrides={},extra={}}){
 let handler;const c={Request,Response,URL,Date,Object,Number,JSON,Error,SyntaxError,TextDecoder,Uint8Array,console:{error(){},warn(){}},
  ...apple,nativeAttempt,nativePurchaseGrant,nativePurchaseReceipt,purchaseEnvironments,preparationEnvironment,captureReceipt,ReceiptError,
  createClient:()=>admin,Stripe:function(){throw Error('No Stripe calls allowed in these tests');},...extra,
  Deno:{env:{get:k=>({...env,...overrides})[k]},serve:f=>handler=f}};
 vm.runInNewContext(stripTypeScriptTypes(read('supabase/functions/'+slug+'/index.ts').replace(/^import .*\n/gm,'')),c);
 return body=>handler(new Request('https://unit.invalid/'+slug,{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify(body)}));
}
test('adapter preserves current and submitted verified JWS privately across direct and by-ID paths',async()=>{
 const tx={transactionId:'100',appAccountToken:F.order,environment:'Sandbox',productId:F.sku,price:1000000,currency:'JPY',purchaseDate:Date.now(),type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED'};
 const p=provider(new Map([['submitted-100',tx],['current-100',tx]]));const api=appleModule(p);
 const result=await api.verifiedTransaction('submitted-100');assert.equal(result.verifiedSignedTransaction,'current-100');assert.equal(result.submittedSignedTransaction,'submitted-100');
 assert(!JSON.stringify(result).includes('current-100'));assert(!Object.keys(result).includes('verifiedSignedTransaction'));
 const byId=await api.appleConfig().verifier.verifiedTransactionById('100','Sandbox');assert.equal(byId.verifiedSignedTransaction,'current-100');assert.equal(byId.submittedSignedTransaction,undefined);
 assert(p.calls.every(x=>['verifier.example.invalid','api.storekit-sandbox.apple.com'].includes(x.host)));
});
for(const kind of ['voice','boost'])test(`${kind} actual Edge + verifier adapter + SQL records winner and excess without issuing excess finish authority`,async()=>{
 const db=await database(kind);try{
  const {next}=await F.cancelledRetry(db);await F.admission(db,'begin',F.fresh,next.attemptNonce);
  const old=await txFor(db,F.order,'100',kind),fresh=await txFor(db,F.fresh,'200',kind);
  const p=provider(new Map([['submitted-100',old],['current-100',old],['submitted-200',fresh],['current-200',fresh]]));
  const {admin,calls}=adminFor(db);const send=endpoint(kind+'-iap',{admin,apple:appleModule(p)});
  const first=await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3});assert.equal(first.status,200);const winner=await first.json();assert.equal(winner.nativeReceipt.finishAllowed,true);assert.equal(winner.nativeReceipt.ownerId,F.owner);
  const second=await send({action:'verify',signedTransaction:'submitted-200',nativeProtocol:3});assert.equal(second.status,409);const duplicate=await second.json();assert.equal(duplicate.nativeReceipt.finishAllowed,false);assert.equal(duplicate.nativeReceipt.fulfillmentGranted,false);assert.equal(duplicate.nativeReceipt.receiptClassification,'excess_payment_review');assert.equal(duplicate.nativeGrant,undefined);
  assert.equal((await db.query(`select count(*)::int n from ${kind==='voice'?'payments':'listing_boosts'}`)).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipt_evidence')).rows[0].n,4);
  assert.equal(calls.filter(x=>x.name==='apply_native_verified_receipt').length,2);assert(!calls.some(x=>x.name==='apply_verified_apple_voice'||x.name==='apply_owned_priced_apple_boost'));
 }finally{await db.close();}
});
test('actual Apple notification route classifies late excess and its refund without touching winner',async()=>{
 const db=await database();try{
  await F.cancelledRetry(db);const winner=await txFor(db,F.fresh,'100'),duplicate=await txFor(db,F.order,'200');
  const map=new Map([['submitted-100',winner],['current-100',winner],['submitted-200',duplicate],['current-200',duplicate]]);const p=provider(map),apple=appleModule(p),{admin,calls}=adminFor(db);
  const notify=endpoint('apple-boost-notifications',{admin,apple});
  assert.equal((await notify({signedPayload:'notice-100'})).status,200);assert.equal((await notify({signedPayload:'notice-200'})).status,200);
  map.set('current-200',{...duplicate,revocationDate:Date.now(),refundEvidenceVersion:1,revocationType:'REFUND_FULL',revocationPercentage:100000});
  assert.equal((await notify({signedPayload:'notice-200'})).status,200);
  const receipts=(await db.query('select transaction_id,classification,revoked from voice_flea_private.native_verified_receipts order by transaction_id')).rows;
  assert.equal(receipts[1].revoked,true);assert.equal(receipts[1].classification,'excess_payment_review');assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
  assert(calls.filter(x=>x.name==='apply_native_verified_receipt').every(x=>x.args.actor===null));
 }finally{await db.close();}
});
test('by-ID delivery verification reaches central receipt gate; excess payment cannot authorize acceptance',async()=>{
 const db=await database();try{
  await F.cancelledRetry(db);const winner=await txFor(db,F.fresh,'100'),duplicate=await txFor(db,F.order,'200');const p=provider(new Map([['current-100',winner],['current-200',duplicate]]));const apple=appleModule(p);
  const base=adminFor(db);const applied=await apple.applyTransaction(base.admin,await apple.appleConfig().verifier.verifiedTransactionById('100','Sandbox'),F.owner);
  const payment=(await db.query('select * from payments where id=$1',[applied.paymentId])).rows[0];const trade=(await db.query('select id from conversations where payment_id=$1',[payment.id])).rows[0].id;
  let finalize=0;
  const {admin,calls}=adminFor(db,{rpcHook:async(name)=>name==='prepare_delivery_acceptance'?{data:{payment:{...payment,apple_transaction_id:'200'},conversation:{id:trade},alreadyAccepted:false}}:name==='finalize_delivery_acceptance'?(finalize++,{data:{delivery_status:'accepted'}}):undefined});
  const send=endpoint('accept-delivery',{admin,apple});assert.equal((await send({conversationId:trade})).status,503);assert.equal(finalize,0);
  assert(calls.some(x=>x.name==='apply_native_verified_receipt'));assert.equal((await db.query('select classification from voice_flea_private.native_verified_receipts where transaction_id=$1',['200'])).rows[0].classification,'excess_payment_review');
 }finally{await db.close();}
});
test('proof persistence failure does not return a native success or finish grant after financial apply',async()=>{
 const db=await database();try{
  await F.admission(db,'register');const tx=await txFor(db,F.order,'100');const p=provider(new Map([['submitted-100',tx],['current-100',tx]]));
  const {admin}=adminFor(db,{rpcHook:async(name)=>name==='retain_native_verified_evidence'?{error:{message:'synthetic storage unavailable'}}:undefined});
  const send=endpoint('voice-iap',{admin,apple:appleModule(p)});const response=await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3});assert.equal(response.status,503);assert.equal((await response.json()).nativeReceipt,undefined);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])for(const duplicate of [false,true])test(`${kind} ${duplicate?'excess':'winner'} partial observation survives direct/notification/stale replay without unsafe grants`,async()=>{
 const db=await database(kind);try{
  await F.cancelledRetry(db);const win=await txFor(db,F.order,'100',kind),second=await txFor(db,F.fresh,'200',kind),id=duplicate?'200':'100',subject=duplicate?second:win;
  const map=new Map([['submitted-100',win],['current-100',win],['submitted-200',second],['current-200',second]]);
  const p=provider(map),apple=appleModule(p),{admin}=adminFor(db),send=endpoint(kind+'-iap',{admin,apple}),notify=endpoint('apple-boost-notifications',{admin,apple});
  assert.equal((await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3})).status,200);
  if(duplicate)assert.equal((await send({action:'verify',signedTransaction:'submitted-200',nativeProtocol:3})).status,409);
  const partial={...subject,refundEvidenceVersion:1,revocationDate:Date.now(),revocationType:'REFUND_PRORATED',revocationPercentage:50000};map.set('current-'+id,partial);
  const held=await send({action:'verify',signedTransaction:'submitted-'+id,nativeProtocol:3});assert.equal(held.status,409);assert.equal((await held.json()).nativeGrant,undefined);
  assert.equal((await notify({signedPayload:'notice-'+id})).status,503);
  const recorded=(await db.query('select exists(select 1 from voice_flea_private.native_refund_review_holds h where h.transaction_id=r.transaction_id and h.environment=r.environment) refund_review_required,revoked from voice_flea_private.native_verified_receipts r where transaction_id=$1',[id])).rows[0];assert.equal(recorded.refund_review_required,true);assert.equal(recorded.revoked,false);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipt_evidence where transaction_id=$1',[id])).rows[0].n,2);
  map.set('current-'+id,subject);const replay=await send({action:'verify',signedTransaction:'submitted-'+id,nativeProtocol:3});assert.equal(replay.status,409);const body=await replay.json();assert.equal(body.nativeGrant,undefined);assert.notEqual(body.nativeReceipt?.finishAllowed,true);
  if(kind==='voice'){
   assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
   assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) eligible from payments p')).rows[0].eligible,duplicate);
  }else{const boosts=(await db.query('select status from listing_boosts')).rows;assert.equal(boosts.length,1);assert.equal(boosts[0].status,'active');}
  map.set('current-'+id,{...subject,refundEvidenceVersion:1,revocationDate:Date.now(),revocationType:'REFUND_FULL',revocationPercentage:100000});await send({action:'verify',signedTransaction:'submitted-'+id,nativeProtocol:3});
  assert.equal((await db.query('select revoked from voice_flea_private.native_verified_receipts where transaction_id=$1',[id])).rows[0].revoked,true);
  if(duplicate&&kind==='voice')assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
 }finally{await db.close();}
});
for(const evidence of [{revocationType:'REFUND_PRORATED',revocationPercentage:50000},{revocationDate:Date.now(),refundEvidenceVersion:99}])test(`first ambiguous receipt (${JSON.stringify(evidence)}) is durable without fulfillment`,async()=>{
 const db=await database();try{
  await F.admission(db,'register');const tx=await txFor(db,F.order,'100'),map=new Map([['submitted-100',tx],['current-100',{...tx,...evidence}]]),p=provider(map),{admin}=adminFor(db),send=endpoint('voice-iap',{admin,apple:appleModule(p)});
  const r=await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3});assert.equal(r.status,409);assert.equal((await r.json()).nativeReceipt,undefined);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  assert.equal((await db.query('select classification from voice_flea_private.native_verified_receipts')).rows[0].classification,'refund_review_unfulfilled');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipt_evidence')).rows[0].n,2);
  map.set('current-100',tx);assert.equal((await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3})).status,409);assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
 }finally{await db.close();}
});
for(const path of ['dispatch','recover','bank','delivery'])test(`${path} actual Edge + SQL cannot use stale positive receipt after durable winner refund hold`,async()=>{
 const db=await database('voice','Production');try{
  const tx=await txFor(db,F.order,'100'),map=new Map([['current-100',tx]]),p=provider(map),apple=appleModule(p),base=adminFor(db);
  const result=await apple.applyTransaction(base.admin,await apple.appleConfig().verifier.verifiedTransactionById('100','Production'),F.owner);
  const payment=(await db.query('select * from payments')).rows[0];assert.equal(payment.id,result.paymentId);
  map.set('current-100',{...tx,refundEvidenceVersion:1,revocationDate:Date.now(),revocationType:'REFUND_PRORATED',revocationPercentage:50000});
  await assert.rejects(apple.applyTransaction(base.admin,await apple.appleConfig().verifier.verifiedTransactionById('100','Production'),F.owner),/APPLE_REFUND_REVIEW_HELD/);
  map.set('current-100',tx);
  let afterGate=0;const op={id:F.fresh,payment_id:payment.id,platform_id:'acct_test'};
  const {admin,calls}=adminFor(db,{rpcHook:async name=>name==='prepare_apple_settlement'?{data:op}:name==='get_apple_financial_review'?{data:null}:name==='apple_financial_resolution_context'?{data:{payment,operation:op}}:name==='prepare_delivery_acceptance'?{data:{payment,conversation:{id:F.fresh},alreadyAccepted:false}}:undefined});
  admin.from=()=>({select:()=>({eq:()=>({single:async()=>({data:payment})})})});
  const overrides={ADMIN_USER_ID:F.owner,APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID:'acct_test',STRIPE_SECRET_KEY:'rk_live_synthetic_no_network'};
  const Stripe=function(){this.accounts={retrieve:async()=>({id:'acct_test'})};};
  const extra={Stripe,dispatchAppleSettlement:async options=>{await options.verifyApple(payment.id);afterGate++;return {};},recoverAppleSettlement:async options=>{await options.verifyRefund(payment.id);afterGate++;return {};},collectApplePayoutEvidence:async()=>{afterGate++;throw Error('Unexpected payout read');}};
  const slug=path==='bank'?'apple-financial-resolution':path==='delivery'?'accept-delivery':'apple-settlement';
  const body=path==='bank'?{action:'previewBankReceipt',operationId:F.fresh,paymentId:payment.id}:path==='delivery'?{conversationId:F.fresh}:{action:path,paymentId:payment.id};
  const response=await endpoint(slug,{admin,apple,overrides,extra})(body);assert.notEqual(response.status,200);assert.equal(afterGate,0);
  assert(calls.some(x=>x.name==='apply_native_verified_receipt'));assert(!calls.some(x=>['store_apple_financial_review','approve_apple_financial_review','finalize_delivery_acceptance','claim_apple_settlement','claim_apple_recovery'].includes(x.name)));
  assert.equal((await db.query('select status,refunded_amount_jpy from payments')).rows[0].refunded_amount_jpy,0);
 }finally{await db.close();}
});
test('original evidence append is service-only, exact-bound, idempotent and never grants',async()=>{
 const db=await database();try{
  const tx=await txFor(db,F.order,'100'),p=provider(new Map([['current-100',tx]])),apple=appleModule(p),{admin}=adminFor(db);
  await apple.applyTransaction(admin,await apple.appleConfig().verifier.verifiedTransactionById('100','Sandbox'),F.owner);
  const sql='select public.retain_native_verified_evidence($1,$2,$3,$4,$5)';const args=[F.owner,F.order,'100','Sandbox','original-proof'];
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query(sql,args),/permission denied/);await db.exec('reset role');}
  for(const bad of [[F.seller,F.order,'100','Sandbox','x'],[F.owner,F.fresh,'100','Sandbox','x'],[F.owner,F.order,'100','Production','x'],[F.owner,F.order,'200','Sandbox','x'],[F.owner,F.order,'100','Sandbox','']])await assert.rejects(db.query(sql,bad),/binding mismatch|Order owner mismatch|Transaction already assigned/);
  await db.exec('set role service_role');await db.query(sql,args);await db.query(sql,args);await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipt_evidence')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])test(`legacy build44 ${kind} exact verified current receipt preserves success without v3 adoption`,async()=>{
 const db=await R.fixture(kind,'Sandbox',false);try{
  await db.exec(read('supabase/migrations/20261109050000_native_submitted_receipt_evidence.sql'));await db.exec(read('supabase/migrations/20261109060000_legacy_refund_observations.sql'));
  const row=(await db.query(`select * from voice_flea_private.${kind==='voice'?'voice_iap_orders':'boost_orders'} where id=$1`,[F.order])).rows[0];
  const tx={transactionId:'100',appAccountToken:F.order,environment:'Sandbox',productId:row.product_id,price:(kind==='voice'?1000:300)*1000,currency:'JPY',purchaseDate:new Date(row.created_at).getTime(),type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED'};
  const p=provider(new Map([['submitted-100',tx],['current-100',tx]])),{admin}=adminFor(db),send=endpoint(kind+'-iap',{admin,apple:appleModule(p)});
  const response=await send({action:'verify',signedTransaction:'submitted-100'});assert.equal(response.status,200);const body=await response.json();assert.equal(body.nativeReceipt,undefined);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,0);
  assert.equal((await db.query(`select count(*)::int n from ${kind==='voice'?'payments':'listing_boosts'}`)).rows[0].n,1);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])for(const state of ['first','winner','excess'])for(const type of ['REFUND_PRORATED','REFUND_FULL'])test(`${kind} ${state} submitted ${type} versus positive current is held before grant/finish`,async()=>{
 const db=await database(kind);try{
  await F.cancelledRetry(db);const win=await txFor(db,F.order,'100',kind),second=await txFor(db,F.fresh,'200',kind),id=state==='excess'?'200':'100',subject=state==='excess'?second:win;
  const map=new Map([['submitted-100',win],['current-100',win],['submitted-200',second],['current-200',second]]),p=provider(map),apple=appleModule(p),{admin}=adminFor(db),send=endpoint(kind+'-iap',{admin,apple}),notify=endpoint('apple-boost-notifications',{admin,apple});
  if(state!=='first')assert.equal((await send({action:'verify',signedTransaction:'submitted-100',nativeProtocol:3})).status,200);
  if(state==='excess')assert.equal((await send({action:'verify',signedTransaction:'submitted-200',nativeProtocol:3})).status,409);
  map.set('submitted-'+id,{...subject,refundEvidenceVersion:1,revocationDate:Date.now(),revocationType:type,revocationPercentage:type==='REFUND_FULL'?100000:50000});
  const response=await send({action:'verify',signedTransaction:'submitted-'+id,nativeProtocol:3});assert.equal(response.status,409);const body=await response.json();assert.equal(body.nativeGrant,undefined);assert.equal(body.nativeReceipt,undefined);
  assert.equal((await notify({signedPayload:'notice-'+id})).status,503);
  const receipt=(await db.query('select classification,revoked from voice_flea_private.native_verified_receipts where transaction_id=$1',[id])).rows[0];assert.equal(receipt.revoked,false);assert.equal(receipt.classification,state==='first'?'refund_review_unfulfilled':state==='winner'?'winner':'excess_payment_review');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_refund_review_holds where transaction_id=$1',[id])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipt_evidence where transaction_id=$1',[id])).rows[0].n,2);
  assert.equal((await db.query(`select count(*)::int n from ${kind==='voice'?'payments':'listing_boosts'}`)).rows[0].n,state==='first'?0:1);
  map.set('submitted-'+id,subject);assert.equal((await send({action:'verify',signedTransaction:'submitted-'+id,nativeProtocol:3})).status,409);
  if(state==='excess'&&kind==='voice')assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) eligible from payments p')).rows[0].eligible,true);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])for(const state of ['first','winner','excess'])test(`unopted ${kind} ${state} refund observation remains held through positive replay`,async()=>{
 const db=await R.fixture(kind,'Sandbox',false);try{
  await db.exec(read('supabase/migrations/20261109050000_native_submitted_receipt_evidence.sql'));await db.exec(read('supabase/migrations/20261109060000_legacy_refund_observations.sql'));
  const row=(await db.query(`select * from voice_flea_private.${kind==='voice'?'voice_iap_orders':'boost_orders'} where id=$1`,[F.order])).rows[0];
  const base={appAccountToken:F.order,environment:'Sandbox',productId:row.product_id,price:(kind==='voice'?1000:300)*1000,currency:'JPY',purchaseDate:new Date(row.created_at).getTime(),type:'Consumable',quantity:1,inAppOwnershipType:'PURCHASED'};
  const win={...base,transactionId:'100'},tx=state==='excess'?{...base,transactionId:'200'}:win,id=tx.transactionId;
  const map=new Map([['submitted-100',win],['current-100',win],['submitted-200',tx],['current-200',tx]]),p=provider(map),apple=appleModule(p),{admin}=adminFor(db),send=endpoint(kind+'-iap',{admin,apple}),notify=endpoint('apple-boost-notifications',{admin,apple});
  if(state!=='first')assert.equal((await send({action:'verify',signedTransaction:'submitted-100'})).status,200);
  map.set('submitted-'+id,{...tx,refundEvidenceVersion:1,revocationType:'REFUND_PRORATED',revocationPercentage:50000});
  const observed=await send({action:'verify',signedTransaction:'submitted-'+id});assert.notEqual(observed.status,200);assert.equal((await observed.json()).nativeGrant,undefined);
  assert.notEqual((await notify({signedPayload:'notice-'+id})).status,200);
  map.set('submitted-'+id,tx);const replay=await send({action:'verify',signedTransaction:'submitted-'+id});assert.notEqual(replay.status,200);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,0);
  assert.equal((await db.query(`select count(*)::int n from ${kind==='voice'?'payments':'listing_boosts'}`)).rows[0].n,state==='first'?0:1);
  if(state==='excess'&&kind==='voice')assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) eligible from payments p')).rows[0].eligible,true);
  if(state==='winner'&&kind==='voice')assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) eligible from payments p')).rows[0].eligible,false);
 }finally{await db.close();}
});
