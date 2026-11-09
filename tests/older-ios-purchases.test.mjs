import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {nativePurchaseGrant} from '../supabase/functions/_shared/native-purchase-grant.mjs';
import {purchaseEnvironments,preparationEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
import {nativeAttempt} from '../supabase/functions/_shared/native-purchase-attempt.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const swift=read('BoostPlugin.swift'),html=read('index.html');
const owner='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',order='00000000-0000-4000-8000-000000000003',order2='00000000-0000-4000-8000-000000000004',sku='com.ayuhide.koenofurima.voice.jpy1000';
const tx={transactionId:'123',appAccountToken:order,productId:sku,environment:'Sandbox',price:1000000,currency:'JPY'};
const grant=overrides=>nativePurchaseGrant({tx,ownerId:owner,result:{paymentId:order,environment:'Sandbox'},backendUrl:'https://tyulybijubckitybgubc.supabase.co',...overrides});
test('native grant binds exact verified transaction, original project, authenticated owner, JPY amount and environment',()=>{
 assert.deepEqual(grant(),{version:1,backendProjectRef:'tyulybijubckitybgubc',ownerId:owner,transactionId:'123',orderId:order,productId:sku,environment:'Sandbox',amountJpy:1000});
 for(const fields of [{backendUrl:'https://foreign.supabase.co'},{backendUrl:'http://tyulybijubckitybgubc.supabase.co'},{ownerId:'invalid'},{result:null},{result:{environment:'Production'}},{tx:{...tx,currency:'USD'}},{tx:{...tx,price:1000001}},{tx:{...tx,environment:'Xcode'}},{tx:{...tx,appAccountToken:'invalid'}}])assert.throws(()=>grant(fields));
 assert.equal(grant({result:{revoked:true}}).environment,'Sandbox','legacy durable boost revocation may omit environment');
});
test('native attempts propagate storage failures rather than manufacturing accepted status',async()=>{
 await assert.rejects(nativeAttempt({rpc:async()=>({error:{}})},owner,'begin'),/UNCONFIRMED/);
 let args;await nativeAttempt({rpc:async(n,a)=>{args=a;return {data:{pending:null}};}},owner,'status');assert.equal(args.actor,owner);assert.equal(args.operation,'status');
});
test('iOS15 recovery keeps signed proof, server-first finish, explicit finish-returned proof and legacy fail-closed path',()=>{
 assert.doesNotMatch(swift,/guard #available\(iOS 18/);assert.match(swift,/#available\(iOS 16.0/);
 assert.match(swift,/payload\["environment"\] as\? String == environment/);
 const purchase=swift.slice(swift.indexOf('@objc func purchase'),swift.indexOf('@objc func pendingTransactions'));
 assert(purchase.indexOf('journal.begin(')<purchase.indexOf('action: "nativeBegin"'));
 assert(purchase.indexOf('action: "nativeBegin"')<purchase.indexOf('product.purchase('));
 assert(purchase.indexOf('journal.retainSignedTransaction')<purchase.indexOf('"status": "purchased"'));
 assert.doesNotMatch(purchase,/action: "nativeCancel"|clearCancelled/);
 assert.match(swift,/archiveAppliedFinishUncertain/);
 assert.match(swift,/"finished": false, "financiallyApplied": true/);
 const finish=swift.slice(swift.indexOf('private func finishOwnedTransaction'),swift.indexOf('@objc func finish'));
 assert(finish.indexOf('journal.retainSignedTransaction')<finish.indexOf('journal.recordVerifiedGrant'));
 assert(finish.indexOf('journal.recordVerifiedGrant')<finish.indexOf('await transaction.finish()'));
 assert(finish.indexOf('await transaction.finish()')<finish.indexOf('journal.recordFinishReturned'));
 assert(finish.indexOf('journal.recordFinishReturned')<finish.indexOf('journal.clearFinished'));
 assert.match(swift,/if attempt.finishReturned == true, let signed = attempt.signedTransaction/);
 assert.match(swift,/let grant = try await confirmServerGrant/);assert.match(swift,/grant\["amountJpy"\] as\? Int == price \/ 1000/);
 assert.match(swift,/completionHandler\(nil\)/);assert.match(swift,/\.ephemeral/);
 assert.match(swift,/for await result in Transaction.all/,'legacy 18+ fallback retained');
 assert.match(swift,/guard attempt.transactionID == raw else/);
});
test('all authenticated bridge operations reject a switched owner and pass only current ephemeral credentials',async()=>{
 const calls=[],raw={pendingTransactions:async a=>calls.push(a),purchase:async a=>calls.push(a),finish:async a=>calls.push(a),products:async()=>({})};
 const c=vm.createContext({isNativeBoost:()=>true,boostNative:raw,currentUser:{id:owner},sb:{auth:{getSession:async()=>({data:{session:{user:{id:owner},access_token:'synthetic-only'}}})}}});
 vm.runInContext(html.slice(html.indexOf('async function nativeBoost(){'),html.indexOf('async function boostApi(')),c);
 const {plugin}=await c.nativeBoost();for(const method of ['pendingTransactions','purchase','finish'])await plugin[method]({transactionId:'123'});
 assert.equal(calls.length,3);for(const a of calls){assert.equal(a.ownerId,owner);assert.equal(a.accessToken,'synthetic-only');}
 c.currentUser={id:other};for(const method of ['pendingTransactions','purchase','finish'])await assert.rejects(plugin[method]({}));assert.equal(calls.length,3);
 assert.doesNotMatch(swift.slice(swift.indexOf('struct KoePurchaseAttempt'),swift.indexOf('// KOEFURIMA_PURCHASE_JOURNAL_END')),/accessToken/);
});
async function database(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema voice_flea_private;create table voice_flea_private.account_deletions(user_id uuid primary key);create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select not exists(select 1 from voice_flea_private.account_deletions where user_id=actor)$$;create table auth.users(id uuid primary key);insert into auth.users values('${owner}'),('${other}');
 create table voice_flea_private.voice_iap_orders(id uuid primary key,buyer_id uuid,product_id text,environment text,amount_jpy integer,state text);
 insert into voice_flea_private.voice_iap_orders values('${order}','${owner}','${sku}','Sandbox',1000,'prepared'),('${order2}','${owner}','${sku}','Sandbox',1000,'prepared');
 create table voice_flea_private.boost_orders(id uuid primary key,seller_id uuid,product_id text,environment text,plan text,state text);`);
 await db.exec(read('supabase/migrations/20261109020000_native_purchase_attempts.sql'));return db;
}
const act=(db,operation,fields={})=>db.query('select public.native_purchase_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[fields.owner??owner,operation,fields.order??order,fields.sku??sku,fields.environment??'Sandbox',fields.amount??1000,fields.tx??null,fields.nonce??'00000000-0000-4000-8000-000000000005',fields.signed??'synthetic-jws']).then(x=>x.rows[0].r);
test('durable precharge latch survives reinstall/elapsed time and blocks duplicate, cross-device, wrong-owner/env/amount begins',async()=>{
 const db=await database();try{
  for(const f of [{owner:other},{environment:'Production'},{amount:1},{sku:'wrong'}])await assert.rejects(act(db,'begin',f),/mismatch/);
  await act(db,'begin');assert.equal((await act(db,'status')).pending.orderId,order);
  await db.exec("update voice_flea_private.native_purchase_attempts set created_at='2000-01-01'");
  await assert.rejects(db.query('insert into voice_flea_private.account_deletions values($1)',[owner]),/Unresolved Apple/);
  await assert.rejects(act(db,'begin'),/unresolved/);await assert.rejects(act(db,'begin',{order:order2}),/unique/);
  await assert.rejects(act(db,'cancel',{owner:other}),/mismatch/);await assert.rejects(act(db,'settle',{environment:'Production',tx:'123'}),/mismatch/);
  assert.equal((await act(db,'status')).pending.orderId,order);
  await act(db,'settle',{tx:'123'});await act(db,'settle',{tx:'123'});assert.equal((await act(db,'status')).pending.transactionId,'123');
  await assert.rejects(act(db,'begin',{order:order2}),/unique/);
  await act(db,'finish',{tx:'123'});assert.equal((await act(db,'status')).pending,null);
  await db.query('insert into voice_flea_private.account_deletions values($1)',[owner]);
  await assert.rejects(act(db,'begin',{order:order2}),/Account unavailable/);
  await act(db,'settle',{tx:'123'});assert.equal((await act(db,'status')).pending,null,'reverification cannot reopen confirmed finish');
  await assert.rejects(act(db,'settle',{tx:'456'}),/mismatch/);await assert.rejects(act(db,'cancel'),/independent reconciliation/);
  await db.exec('set role authenticated');await assert.rejects(act(db,'status'),/permission denied/);
 }finally{await db.close();}
});
test('owner JWT/status nonce cannot clear a pending purchase through cancellation or finish/defer acknowledgements',async()=>{
 const db=await database();try{
  await act(db,'begin');const pending=(await act(db,'status')).pending;
  await assert.rejects(act(db,'cancel',{nonce:pending.attemptNonce}),/independent reconciliation/);
  for(const operation of ['finish','defer_finish'])await assert.rejects(act(db,operation,{nonce:pending.attemptNonce,tx:'123'}),/evidence mismatch/);
  await assert.rejects(act(db,'begin',{order:order2}),/unique/);
  assert.equal((await act(db,'status')).pending.orderId,order);
  assert.equal((await act(db,'settle',{order:order2,tx:'999'})).settled,true);
 }finally{await db.close();}
});
test('durably applied finish-uncertain state keeps proof, releases only its hold, and re-verification never reopens it',async()=>{
 const db=await database();try{
  await act(db,'begin');await act(db,'settle',{tx:'123'});
  for(const f of [{owner:other},{tx:'999'},{amount:1},{environment:'Production'},{nonce:order2}])await assert.rejects(act(db,'defer_finish',{tx:'123',...f}),/mismatch/);
  await act(db,'defer_finish',{tx:'123'});await act(db,'defer_finish',{tx:'123'});
  assert.equal((await act(db,'status')).pending,null);
  await act(db,'settle',{tx:'123'});assert.equal((await act(db,'status')).pending,null);
  const row=(await db.query('select * from voice_flea_private.native_purchase_attempts')).rows[0];
  assert.equal(row.state,'applied_finish_uncertain');assert.equal(row.transaction_id,'123');assert.equal(row.signed_transaction,'synthetic-jws');
  await act(db,'begin',{order:order2});
  await act(db,'finish',{tx:'123'});assert.equal((await act(db,'status')).pending.orderId,order2);
  await act(db,'defer_finish',{tx:'123'});assert.equal((await db.query('select state from voice_flea_private.native_purchase_attempts where order_id=$1',[order])).rows[0].state,'finished');
 }finally{await db.close();}
});

// Run actual endpoint source with only external services replaced. Never contacts
// Supabase or Apple and uses synthetic tokens/IDs only.
async function edgeFixture(kind,{failSettle=false,applyFailure=false,gates=true,voiceEnvironment='Sandbox',boostEnvironment='Sandbox',db=null}={}){
 const {stripTypeScriptTypes}=await import('node:module');let handler;const calls=[];
 const actualTx={...tx,productId:kind==='boost'?'com.ayuhide.koenofurima.boost.silver':sku,price:kind==='boost'?300000:1000000};
 const admin={auth:{getUser:async()=>({data:{user:{id:owner}}})},rpc:async(name,args)=>{calls.push(args.operation);if(db){try{return {data:await act(db,args.operation,{owner:args.actor,order:args.requested_order,sku:args.sku,environment:args.tx_environment,amount:args.price_jpy,tx:args.tx_id,nonce:args.requested_nonce,signed:args.requested_signed})};}catch{return {error:{}};}}if(failSettle&&args.operation==='settle')return {error:{}};return {data:args.operation==='status'?{pending:null}:{accepted:true}};}};
 const c=vm.createContext({Request,Response,URL,TextDecoder,Uint8Array,console:{error(){}},nativePurchaseGrant,nativeAttempt,purchaseEnvironments,preparationEnvironment,
  createClient:()=>admin,appleConfig(){},enabled:()=>gates,
  verifiedTransaction:async()=>{calls.push('verify');return actualTx;},
  applyTransaction:async(a,t,actor)=>{assert.equal(actor,owner);calls.push('apply');if(applyFailure)throw Error('offline');return {environment:'Sandbox',paymentId:order};},
  Deno:{serve:f=>handler=f,env:{get:k=>({SUPABASE_URL:'https://tyulybijubckitybgubc.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',VOICE_IAP_ENVIRONMENT:voiceEnvironment,BOOST_IAP_ENVIRONMENT:boostEnvironment,BOOST_IAP_ENABLED:gates?'true':'false',VOICE_IAP_ENABLED:gates?'true':'false'})[k]}}});
 vm.runInContext(stripTypeScriptTypes(read('supabase/functions/'+kind+'-iap/index.ts').replace(/^import .*;\n/gm,'')),c);
 return {calls,send:body=>handler(new Request('https://unit.invalid',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify(body)}))};
}
for(const kind of ['voice','boost'])test(kind+' native protocol issues exact grant only after verified durable apply and latch settle; old44 path unchanged',async()=>{
 const f=await edgeFixture(kind);const response=await f.send({action:'verify',signedTransaction:'synthetic-jws',nativeProtocol:1,actor:other,environment:'Production'});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.nativeGrant.ownerId,owner);assert.equal(body.nativeGrant.environment,'Sandbox');assert.deepEqual(f.calls,['verify','apply','settle']);
 for(const failure of [{failSettle:true},{applyFailure:true}]){const b=await edgeFixture(kind,failure);const r=await b.send({action:'verify',signedTransaction:'synthetic-jws',nativeProtocol:1});assert.equal(r.status,503);assert.equal((await r.json()).nativeGrant,undefined);}
 const old=await edgeFixture(kind);const r=await old.send({action:'verify',signedTransaction:'synthetic-jws'});assert.equal(r.status,200);assert.equal((await r.json()).nativeGrant,undefined);assert.deepEqual(old.calls,['verify','apply']);
});
test('native attempt recovery remains enabled with new sales disabled; begin observes current sales gate',async()=>{
 const f=await edgeFixture('boost',{gates:false});assert.equal((await f.send({action:'nativeStatus'})).status,200);
 assert.equal((await f.send({action:'nativeBegin',productId:sku})).status,409);assert.deepEqual(f.calls,['status']);
});

test('nativeBegin rechecks the correct kind environment; recovery does not depend on current sales mode',async()=>{
 for(const productId of [sku,'com.ayuhide.koenofurima.boost.silver']){
  const f=await edgeFixture('boost');
  assert.equal((await f.send({action:'nativeBegin',productId,environment:'Production'})).status,409);
  assert.equal((await f.send({action:'nativeBegin',productId})).status,409);
  assert.equal((await f.send({action:'nativeBegin',productId,environment:'Sandbox'})).status,200);
  assert.equal((await f.send({action:'nativeCancel',productId})).status,409);
  assert.deepEqual(f.calls,['begin']);
 }
 const f=await edgeFixture('boost',{voiceEnvironment:'Production',boostEnvironment:'Sandbox'});
 assert.equal((await f.send({action:'nativeBegin',productId:sku,environment:'Production'})).status,200);
 assert.equal((await f.send({action:'nativeBegin',productId:'com.ayuhide.koenofurima.boost.silver',environment:'Production'})).status,409);
 const closed=await edgeFixture('boost',{gates:false,voiceEnvironment:'',boostEnvironment:''});
 assert.equal((await closed.send({action:'nativeStatus'})).status,200);
 assert.equal((await closed.send({action:'verify',signedTransaction:'synthetic-jws',nativeProtocol:1})).status,200);
});

test('actual Edge plus SQL rejects status→cancel/finished/defer→new begin without Apple proof',async()=>{
 const db=await database();try{
  const f=await edgeFixture('boost',{db});
  const fields={orderId:order,productId:sku,environment:'Sandbox',amountJpy:1000,attemptNonce:'00000000-0000-4000-8000-000000000005'};
  assert.equal((await f.send({action:'nativeBegin',...fields})).status,200);
  const status=await (await f.send({action:'nativeStatus'})).json();fields.attemptNonce=status.pending.attemptNonce;
  assert.equal((await f.send({action:'nativeCancel',...fields})).status,409);
  for(const action of ['nativeFinished','nativeDeferFinish'])assert.equal((await f.send({action,...fields,transactionId:'123'})).status,503);
  assert.equal((await f.send({action:'nativeBegin',...fields,orderId:order2})).status,503);
  assert.equal((await act(db,'status')).pending.orderId,order);
  assert(!f.calls.includes('verify'));assert(!f.calls.includes('apply'));
 }finally{await db.close();}
});
test('actual Edge plus SQL rejects an old Production prepared order after Sandbox-only gate downgrade',async()=>{
 const db=await database();try{
  await db.query("update voice_flea_private.voice_iap_orders set environment='Production'");
  const f=await edgeFixture('boost',{db});
  assert.equal((await f.send({action:'nativeBegin',orderId:order,productId:sku,environment:'Production',amountJpy:1000,attemptNonce:order2})).status,409);
  assert.equal((await act(db,'status')).pending,null);assert.deepEqual(f.calls,[]);
 }finally{await db.close();}
});

test('a refunded purchase with uncertain native cleanup still shows its refund status',()=>{
 assert.equal((html.match(/finishResult\?\.finishUncertain\?\(receipt\.revoked\?/g)||[]).length,2);
 assert.match(html,/この購入は返金・取り消し済みです。Appleの端末後処理は未確認/);
});
