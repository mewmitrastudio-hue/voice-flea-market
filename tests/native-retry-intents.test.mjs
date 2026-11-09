import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const owner='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004';
const order='00000000-0000-4000-8000-000000000005',fresh='00000000-0000-4000-8000-000000000006',another='00000000-0000-4000-8000-000000000007',sku='com.ayuhide.koenofurima.voice.jpy1000';
const boostListing='00000000-0000-4000-8000-000000000008';
const read=n=>fs.readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
async function fixture(kind='voice'){
 const db=await jobDatabase();await db.exec(`
 create table voice_flea_private.account_deletions(user_id uuid primary key);
 create function voice_flea_private.resolution_operator(actor uuid) returns boolean language sql as $$select false$$;
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 insert into listings(id,seller_id,price_jpy,is_active,title) values('${boostListing}','${owner}',1000,true,'Own listing');
 update voice_flea_private.voice_iap_products set sandbox_enabled=true;`);
 for(const n of ['20261028020000_priced_boost_receipts.sql','20261109010000_dual_iap_preparation.sql','20261109020000_native_purchase_attempts.sql','20261109030000_native_purchase_retry_intents.sql'])await db.exec(read(n));
 if(kind==='voice')await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[owner,listing,order,'Sandbox']);
 else if(kind==='boost')await db.query("insert into voice_flea_private.boost_orders(id,seller_id,listing_id,plan,product_id,environment) values($1,$2,$3,'silver','com.ayuhide.koenofurima.boost.silver','Sandbox')",[order,owner,boostListing]);
 if(kind==='job'){
  await db.exec(`insert into jobs(id,buyer_id,title,budget_jpy) values('${listing}','${owner}','Job',1000);insert into applications(id,job_id,applicant_id,status,proposed_price_jpy) values('${another}','${listing}','${seller}','pending',1000);update applications set status='accepted' where id='${another}';`);
  await db.query('select public.prepare_job_voice_iap_order($1,$2,$3,$4)',[owner,another,order,'Sandbox']);
 }
 return db;
}
const admission=(db,op,id=order,nonce=null,newOrder=null,actor=owner)=>db.query('select public.native_retry_admission($1,$2,$3,$4,$5) r',[actor,op,id,nonce,newOrder]).then(x=>x.rows[0].r);
const time='2026-11-09T00:00:00.000Z';
async function receipt(db,tx,id=order,kind='voice',revoked=false,overrides={}){
 const args={id,tx,sku:kind==='voice'?sku:'com.ayuhide.koenofurima.boost.silver',env:'Sandbox',price:kind==='voice'?1000000:300000,currency:'JPY',revoked,signed:'synthetic-verified-jws-'+tx,actor:owner,...overrides};
 // Fixed per-test purchase time so transaction replays are byte-semantically exact.
 const purchased=(await db.query('select created_at from voice_flea_private.native_retry_attempts where order_id=$1',[id])).rows[0]?.created_at??time;
 return db.query('select public.apply_native_verified_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',[args.id,args.tx,args.sku,args.env,purchased,args.price,args.currency,args.revoked,args.signed,args.actor]).then(x=>x.rows[0].r);
}
async function cancelledRetry(db){const a=await admission(db,'register');assert.equal((await admission(db,'begin',order,a.attemptNonce)).launchGranted,true);await admission(db,'client_cancel',order,a.attemptNonce);return {old:a,next:await admission(db,'retry',order,a.attemptNonce,fresh)};}

test('normal cancellation retires old token, only a new explicit begin launches, and stale cancel cannot clear newer admission',async()=>{
 const db=await fixture();try{
  const {old,next}=await cancelledRetry(db);assert.notEqual(next.attemptNonce,old.attemptNonce);assert.equal(next.intentId,old.intentId);assert.equal(next.orderId,fresh);assert.equal(next.launchGranted,false);
  assert.equal((await admission(db,'begin',order,old.attemptNonce)).launchGranted,false);
  assert.equal((await admission(db,'begin',fresh,next.attemptNonce)).launchGranted,true);
  assert.equal((await admission(db,'begin',fresh,next.attemptNonce)).launchGranted,false);
  await admission(db,'client_cancel',order,old.attemptNonce);
  assert.equal((await admission(db,'status',fresh,next.attemptNonce)).state,'dispatch_unknown');
  await assert.rejects(admission(db,'retry',order,old.attemptNonce,another),/Retry requires/);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipts')).rows[0].n,0);
 }finally{await db.close();}
});
test('lost begin response and Ask-to-Buy never become cancellation by timeout or replay',async()=>{
 const db=await fixture();try{
  const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);
  await db.exec("update voice_flea_private.native_retry_attempts set updated_at='2000-01-01'");
  assert.equal((await admission(db,'begin',order,a.attemptNonce)).launchGranted,false);
  await assert.rejects(admission(db,'retry',order,a.attemptNonce,fresh),/Retry requires/);
  await admission(db,'pending',order,a.attemptNonce);await assert.rejects(admission(db,'client_cancel',order,a.attemptNonce),/Approval is not/);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])for(const winnerOld of [true,false])test(`${kind}: ${winnerOld?'late old':'new retry'} wins once; distinct paid duplicate remains review, with independent refunds`,async()=>{
 const db=await fixture(kind);try{
  const {old,next}=await cancelledRetry(db);await admission(db,'begin',fresh,next.attemptNonce);
  const win=winnerOld?order:fresh,duplicate=winnerOld?fresh:order;
  const first=await receipt(db,'100',win,kind);assert.equal(first.receiptClassification,'winner');
  const extra=await receipt(db,'200',duplicate,kind);assert.equal(extra.receiptClassification,'excess_payment_review');assert.equal(extra.reviewRequired,true);assert.equal(extra.fulfillmentGranted,false);
  assert.equal((await receipt(db,'100',win,kind)).receiptClassification,'winner');
  await receipt(db,'200',duplicate,kind,true);
  let rows=(await db.query(`select ${kind==='voice'?'status':'status'} from ${kind==='voice'?'payments':'listing_boosts'}`)).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].status,kind==='voice'?'paid':'active');
  await receipt(db,'100',win,kind,true);await receipt(db,'200',duplicate,kind,false);
  rows=(await db.query(`select status from ${kind==='voice'?'payments':'listing_boosts'}`)).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].status,kind==='voice'?'refunded':'cancelled');
  const third=await receipt(db,'300',duplicate,kind);assert.equal(third.receiptClassification,'excess_payment_review');
  const ledger=(await db.query('select transaction_id,classification,revoked,signed_transaction from voice_flea_private.native_verified_receipts order by transaction_id')).rows;
  assert.equal(ledger.length,3);assert.equal(ledger[1].revoked,true);assert.equal(ledger.filter(x=>x.classification==='winner').length,1);assert(ledger.every(x=>x.signed_transaction));
  assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,'100');
  await assert.rejects(admission(db,'retry',order,old.attemptNonce,another),/already fulfilled/);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])test(`${kind}: first already-refunded receipt never grants or resurrects; distinct paid receipt can be first winner`,async()=>{
 const db=await fixture(kind);try{
  const {next}=await cancelledRetry(db);await admission(db,'begin',fresh,next.attemptNonce);
  assert.equal((await receipt(db,'100',order,kind,true)).receiptClassification,'refunded_unfulfilled');
  assert.equal((await receipt(db,'100',order,kind,false)).revoked,true);
  assert.equal((await db.query(`select count(*)::int n from ${kind==='voice'?'payments':'listing_boosts'}`)).rows[0].n,0);
  assert.equal((await receipt(db,'200',fresh,kind)).receiptClassification,'winner');
 }finally{await db.close();}
});
test('same-order distinct paid transaction is retained for review, not discarded as already consumed',async()=>{
 const db=await fixture();try{
  const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);
  await receipt(db,'100');assert.equal((await receipt(db,'101')).receiptClassification,'excess_payment_review');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from conversations where payment_id is not null')).rows[0].n,1);
  await admission(db,'client_cancel',order,a.attemptNonce);assert.equal((await admission(db,'status',order,a.attemptNonce)).state,'transaction_observed');
 }finally{await db.close();}
});
test('actor, quote, environment, transaction reassignment, public RPC and legacy grant bypass are rejected',async()=>{
 const db=await fixture();try{
  const {old,next}=await cancelledRetry(db);
  await assert.rejects(admission(db,'status',order,old.attemptNonce,null,seller),/binding/);
  await assert.rejects(admission(db,'begin',fresh,old.attemptNonce),/binding/);
  for(const override of [{actor:seller},{price:1},{sku:'wrong'},{env:'Production'},{currency:'USD'},{signed:''}])await assert.rejects(receipt(db,'100',order,'voice',false,override),/mismatch/);
  await receipt(db,'100',order);
  await assert.rejects(receipt(db,'100',fresh),/already assigned/);
  await assert.rejects(db.query("select public.apply_verified_apple_voice($1,'999',$2,'Sandbox',now(),1000000,'JPY',false,$3)",[order,sku,owner]),/receipt gate/);
  await db.exec('set role authenticated');await assert.rejects(admission(db,'status',order,old.attemptNonce),/permission denied/);await assert.rejects(receipt(db,'100'),/permission denied/);
  await assert.rejects(db.query('select * from voice_flea_private.native_verified_receipts'),/permission denied/);
 }finally{await db.close();}
});
test('changed quote and old prepared rows are not silently reused as retry or new intent',async()=>{
 const db=await fixture();try{
  const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);await admission(db,'client_cancel',order,a.attemptNonce);
  await db.query('update listings set price_jpy=1500 where id=$1',[listing]);await assert.rejects(admission(db,'retry',order,a.attemptNonce,fresh),/Fresh quote/);
 }finally{await db.close();}
 const old=await fixture();try{
  await old.exec("update voice_flea_private.voice_iap_orders set created_at='2000-01-01'");await assert.rejects(admission(old,'register'),/Legacy prepared/);
 }finally{await old.close();}
});

test('retry-response loss is recoverable as status without issuing another StoreKit launch permit',async()=>{
 const db=await fixture();try{
  const {old,next}=await cancelledRetry(db);
  assert.deepEqual(await admission(db,'retry',order,old.attemptNonce,fresh),next);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,2);
  assert.equal((await admission(db,'begin',fresh,next.attemptNonce)).launchGranted,true);
  assert.equal((await admission(db,'retry',order,old.attemptNonce,fresh)).launchGranted,false);
 }finally{await db.close();}
});
test('failed old grant rolls back winner, evidence classification and admission transition atomically',async()=>{
 const db=await fixture();try{
  const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);
  await db.exec("create function fail_grant() returns trigger language plpgsql as $$begin raise exception 'synthetic grant failure';end$$;create trigger fail_grant before insert on payments for each row execute function fail_grant();");
  await assert.rejects(receipt(db,'100'),/synthetic grant failure/);
  assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,null);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_verified_receipts')).rows[0].n,0);
  assert.equal((await admission(db,'status',order,a.attemptNonce)).state,'dispatch_unknown');
  await db.exec('drop trigger fail_grant on payments');assert.equal((await receipt(db,'100')).receiptClassification,'winner');
 }finally{await db.close();}
});
test('receipt history is owner-scoped or operator-checked, excludes signed evidence, and authorizes no money movement',async()=>{
 const db=await fixture();try{
  await db.exec(`create or replace function voice_flea_private.resolution_operator(actor uuid) returns boolean language sql as $$select actor='${seller}'::uuid$$;`);
  await admission(db,'register');await receipt(db,'100');await receipt(db,'200');
  const history=async(actor,operator=false)=>(await db.query('select public.native_retry_receipt_history($1,$2) r',[actor,operator])).rows[0].r;
  const own=await history(owner);assert.equal(own.receipts.length,2);assert.equal(own.paymentMovementAuthorized,false);assert.equal(own.receipts[1].refund_review_required,true);assert(!JSON.stringify(own).includes('synthetic-verified'));
  assert.equal((await history(seller)).receipts.length,0);await assert.rejects(history(owner,true),/Operator required/);assert.equal((await history(seller,true)).receipts.length,2);
  await assert.rejects(db.query('insert into voice_flea_private.account_deletions values($1)',[owner]),/excess payment/);
  await receipt(db,'200',order,'voice',true);assert.equal((await history(owner)).receipts[1].refund_review_required,false);
 }finally{await db.close();}
});
test('legacy untouched orders still reconcile; opting in a same-purpose overlap is rejected',async()=>{
 const db=await fixture();try{
  const result=(await db.query("select public.apply_verified_apple_voice($1,'500',$2,'Sandbox',now(),1000000,'JPY',false,$3) r",[order,sku,owner])).rows[0].r;
  assert(result.paymentId);await assert.rejects(admission(db,'register'),/not prepared/);
 }finally{await db.close();}
 const overlap=await fixture();try{
  await overlap.query('insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment) select $1,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment from voice_flea_private.voice_iap_orders where id=$2',[fresh,order]);
  await assert.rejects(admission(overlap,'register'),/Overlapping prepared/);
 }finally{await overlap.close();}
});

test('old-client price/environment/tier changes cannot create a parallel order after v3 registration',async()=>{
 const db=await fixture();try{
  await admission(db,'register');await db.query('update listings set price_jpy=1500 where id=$1',[listing]);
  for(const env of ['Sandbox','Production'])await assert.rejects(db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[owner,listing,fresh,env]),/native intent recovery/);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,1);
 }finally{await db.close();}
 const boost=await fixture('boost');try{
  await admission(boost,'register');
  for(const tier of ['silver','gold','platinum'])await assert.rejects(boost.query("select public.prepare_boost_order_in_environment($1,$2,$3,'Sandbox')",[owner,boostListing,tier]),/native intent recovery/);
 }finally{await boost.close();}
});
test('server notification actor=null uses the exact same intent winner gate and duplicate refund isolation',async()=>{
 const db=await fixture();try{
  await cancelledRetry(db);const first=await receipt(db,'100',fresh,'voice',false,{actor:null});assert.equal(first.receiptClassification,'winner');
  const second=await receipt(db,'200',order,'voice',false,{actor:null});assert.equal(second.receiptClassification,'excess_payment_review');
  await receipt(db,'200',order,'voice',true,{actor:null});
  assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
 }finally{await db.close();}
});

test('unexpected paid legacy overlap is retained for review without free grant or losing its later refund',async()=>{
 const db=await fixture();try{
  await admission(db,'register');
  // Simulates an exceptional already-existing legacy obligation, NOT a supported prepare bypass.
  await db.query('insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment) select $1,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment from voice_flea_private.voice_iap_orders where id=$2',[fresh,order]);
  const args=[fresh,'999',sku,'Sandbox',new Date(),1000000,'JPY',false,'verified-legacy-overlap',null];
  const result=(await db.query('select public.apply_native_verified_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',args)).rows[0].r;
  assert.equal(result.receiptClassification,'excess_payment_review');assert.equal(result.financiallyRecorded,true);assert.equal(result.fulfillmentGranted,false);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,null);
  args[7]=true;const refunded=(await db.query('select public.apply_native_verified_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',args)).rows[0].r;assert.equal(refunded.revoked,true);
  assert.equal((await db.query('select signed_transaction from voice_flea_private.native_verified_receipts')).rows[0].signed_transaction,'verified-legacy-overlap');
 }finally{await db.close();}
});
test('central receipt sink leaves unrelated legacy success and refund behavior unchanged',async()=>{
 const db=await fixture();try{
  const args=[order,'501',sku,'Sandbox',new Date(),1000000,'JPY',false,'verified-legacy',owner];
  const call=async()=> (await db.query('select public.apply_native_verified_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',args)).rows[0].r;
  const first=await call();assert(first.paymentId);args[7]=true;assert.equal((await call()).revoked,true);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_retry_attempts')).rows[0].n,0);
 }finally{await db.close();}
});

test('original paid and later refund JWS are both retained and repeat delivery does not duplicate evidence',async()=>{
 const db=await fixture();try{
  await admission(db,'register');await receipt(db,'100');
  await receipt(db,'100',order,'voice',true,{signed:'synthetic-refund-jws'});await receipt(db,'100',order,'voice',true,{signed:'synthetic-refund-jws'});
  const rows=(await db.query('select signed_transaction from voice_flea_private.native_verified_receipt_evidence order by id')).rows;
  assert.deepEqual(rows.map(x=>x.signed_transaction),['synthetic-verified-jws-100','synthetic-refund-jws']);
  await db.exec('set role authenticated');await assert.rejects(db.query('select * from voice_flea_private.native_verified_receipt_evidence'),/permission denied/);
 }finally{await db.close();}
});
test('unresolved v3 purpose still blocks Web checkout; client cancellation cannot erase that financial obligation',async()=>{
 const db=await fixture();try{
  await cancelledRetry(db);
  await assert.rejects(db.query("select public.prepare_voice_checkout($1,$2,'acct_seller')",[owner,listing]),/other channel/);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.voice_checkout_intents')).rows[0].n,0);
  await assert.rejects(db.query('insert into voice_flea_private.account_deletions values($1)',[owner]),/Unresolved Apple attempt/);
 }finally{await db.close();}
});
test('legacy boost wrapper cannot bypass an opted-in intent and service_role cannot call private old grant directly',async()=>{
 const db=await fixture('boost');try{
  await admission(db,'register');
  await assert.rejects(db.query("select public.apply_owned_priced_apple_boost($1,'777','com.ayuhide.koenofurima.boost.silver','Sandbox',now(),false,300000,'JPY',$2)",[order,owner]),/receipt gate/);
  await db.exec('set role service_role');
  await assert.rejects(db.query("select voice_flea_private.apply_legacy_apple_boost($1,'777','com.ayuhide.koenofurima.boost.silver','Sandbox',now(),false)",[order]),/permission denied/);
 }finally{await db.close();}
});

test('job retries retain exact accepted contract and one fulfillment; legacy application/channel bypass is blocked',async()=>{
 const db=await fixture('job');try{
  const {next}=await cancelledRetry(db);
  await assert.rejects(db.query("select public.prepare_job_voice_iap_order($1,$2,$3,'Sandbox')",[owner,another,'00000000-0000-4000-8000-000000000009']),/native intent recovery/);
  await assert.rejects(db.query("select public.prepare_job_checkout($1,$2,'acct_seller')",[owner,another]),/existing Apple/);
  const rows=(await db.query('select job_id,job_application_id,amount_jpy from voice_flea_private.voice_iap_orders order by id')).rows;
  assert.equal(rows.length,2);assert.deepEqual(rows[0],rows[1]);
  await admission(db,'begin',fresh,next.attemptNonce);await receipt(db,'100',fresh);await receipt(db,'200',order);
  assert.equal((await db.query('select count(*)::int n from payments where job_id=$1',[listing])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from conversations where job_id=$1 and payment_id is not null',[listing])).rows[0].n,1);
  assert.equal((await db.query('select classification from voice_flea_private.native_verified_receipts where transaction_id=$1',['200'])).rows[0].classification,'excess_payment_review');
 }finally{await db.close();}
});

test('history rejects unbounded/invalid limits and incomplete or invalid cursors',async()=>{
 const db=await fixture();try{
  const history=(env,tx,limit)=>db.query('select public.native_retry_receipt_history($1,false,$2,$3,$4) r',[owner,env,tx,limit]);
  for(const limit of [null,0,101,-1])await assert.rejects(history(null,null,limit),/Invalid reader/);
  for(const [env,tx] of [[null,'1'],['Sandbox',null]])await assert.rejects(history(env,tx,25),/Complete cursor/);
  for(const [env,tx] of [['Unknown','1'],['Sandbox','invalid'],['Sandbox','']])await assert.rejects(history(env,tx,25),/Invalid cursor/);
  assert.deepEqual((await history(null,null,1)).rows[0].r.receipts,[]);
  assert.deepEqual((await history('Sandbox','1',100)).rows[0].r.receipts,[]);
 }finally{await db.close();}
});

test('legacy paid after changed-price quote blocks v3 registration rather than producing a second payment/trade',async()=>{
 const db=await fixture();try{
  await db.query('update listings set price_jpy=1500 where id=$1',[listing]);
  await db.query("select public.prepare_voice_iap_order($1,$2,$3,'Sandbox')",[owner,listing,fresh]);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.voice_iap_orders')).rows[0].n,2);
  await db.query("select public.apply_verified_apple_voice($1,'100',$2,'Sandbox',now(),1000000,'JPY',false,$3)",[order,sku,owner]);
  await assert.rejects(admission(db,'register',fresh),/financial history requires explicit intent/);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from conversations where payment_id is not null')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_fulfillment_intents')).rows[0].n,0);
 }finally{await db.close();}
});
test('legacy boost paid after changed-tier quote blocks v3 registration and a second extension',async()=>{
 const db=await fixture('boost');try{
  const quote=(await db.query("select public.prepare_boost_order_in_environment($1,$2,'gold','Sandbox') r",[owner,boostListing])).rows[0].r;
  await db.query("select public.apply_owned_priced_apple_boost($1,'100','com.ayuhide.koenofurima.boost.silver','Sandbox',now(),false,300000,'JPY',$2)",[order,owner]);
  await assert.rejects(admission(db,'register',quote.orderId),/boost history requires explicit intent/);
  assert.equal((await db.query('select count(*)::int n from listing_boosts')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.native_fulfillment_intents')).rows[0].n,0);
 }finally{await db.close();}
});

test('all legacy apply wrappers acquire owner serialization before their first row lock',()=>{
 const sql=read('20261109030000_native_purchase_retry_intents.sql');
 for(const name of ['apply_verified_apple_voice','apply_verified_apple_boost','apply_owned_priced_apple_boost']){
  const marker=sql.includes('create function public.'+name+'(')?'create function public.'+name+'(':'create or replace function public.'+name+'(';
  const body=sql.slice(sql.indexOf(marker),sql.indexOf('end $$;',sql.indexOf(marker)));
  assert(body.indexOf('pg_advisory_xact_lock')>=0);assert(body.indexOf('pg_advisory_xact_lock')<body.indexOf('for update'));
  assert.match(body,/hashtextextended\(actual_owner::text,16\)/);assert.match(body,/hashtextextended\(actual_owner::text,913\)/);
 }
});
