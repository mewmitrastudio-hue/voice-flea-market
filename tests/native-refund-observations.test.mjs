import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const owner='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const listing='00000000-0000-4000-8000-000000000004',order='00000000-0000-4000-8000-000000000005',fresh='00000000-0000-4000-8000-000000000006';
const boostListing='00000000-0000-4000-8000-000000000008',report='00000000-0000-4000-8000-000000000088';
const sku='com.ayuhide.koenofurima.voice.jpy1000',boostSku='com.ayuhide.koenofurima.boost.silver';
const quoteCache=new WeakMap();
const read=n=>fs.readFileSync(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
// Dedicated loader: no shared fixture, Stage1 test, or frozen SQL changes.
async function fixture(kind='voice',env='Sandbox',register=true){
 const db=await jobDatabase();await db.exec(`
 create table voice_flea_private.account_deletions(user_id uuid primary key,completed_at timestamptz);
 create table voice_flea_private.moderators(user_id uuid primary key);insert into voice_flea_private.moderators values('${seller}');
 create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${seller}'::uuid$$;
 create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 insert into listings(id,seller_id,price_jpy,is_active,title) values('${boostListing}','${owner}',1000,true,'Own listing');
 update voice_flea_private.voice_iap_products set sandbox_enabled=true,production_enabled=true;`);
 for(const n of ['20261028020000_priced_boost_receipts.sql','20261029033154_apple_proceeds_allocation_ledger.sql','20261102003116_keep_allocated_apple_proceeds_pending.sql','20261102020226_guard_apple_refund_settlement_on_deletion.sql','20261102040116_apple_settlement_dispatch_journal.sql','20261102055040_apple_refund_recovery_journal.sql','20261102140552_apple_refund_review_holds.sql','20261102142155_apple_financial_resolution_audit.sql','20261109010000_dual_iap_preparation.sql','20261109020000_native_purchase_attempts.sql','20261109030000_native_purchase_retry_intents.sql','20261109040000_native_refund_observations.sql'])await db.exec(read(n));
 if(kind==='job'){await db.exec(`insert into jobs(id,buyer_id,title,budget_jpy) values('${listing}','${owner}','Job',1000);insert into applications(id,job_id,applicant_id,status,proposed_price_jpy) values('${fresh}','${listing}','${seller}','pending',1000);update applications set status='accepted' where id='${fresh}';`);await db.query('select public.prepare_job_voice_iap_order($1,$2,$3,$4)',[owner,fresh,order,env]);}
 else if(kind==='voice')await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[owner,listing,order,env]);
 else await db.query("insert into voice_flea_private.boost_orders(id,seller_id,listing_id,plan,product_id,environment) values($1,$2,$3,'silver',$4,$5)",[order,owner,boostListing,boostSku,env]);
 if(register)await admission(db,'register');
 quoteCache.set(db,new Map());await args(db,'100');
 return db;
}
const admission=(db,op,id=order,nonce=null,newOrder=null,actor=owner)=>db.query('select public.native_retry_admission($1,$2,$3,$4,$5) r',[actor,op,id,nonce,newOrder]).then(x=>x.rows[0].r);
async function args(db,tx,overrides={}){
 const id=overrides.id??order;
 const cache=quoteCache.get(db);
 const row=cache?.get(id)??(await db.query('select product_id,environment,created_at,amount_jpy from voice_flea_private.native_retry_attempts where order_id=$1',[id])).rows[0]
  ??(await db.query('select product_id,environment,created_at,amount_jpy from voice_flea_private.voice_iap_orders where id=$1',[id])).rows[0];
 cache?.set(id,row);
 return {id,tx,sku:row.product_id,env:row.environment,purchased:row.created_at,price:row.amount_jpy*1000,currency:'JPY',actor:owner,signed:'synthetic-jws-'+tx,...overrides};
}
const partial={refundEvidenceVersion:1,revocationDate:1780000000000,revocationType:'REFUND_PRORATED',revocationPercentage:50000};
async function observe(db,tx='100',overrides={}){
 const a=await args(db,tx,overrides);
 return (await db.query('select public.record_native_refund_observation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.price,a.currency,a.evidence??partial,a.signed,a.actor])).rows[0].r;
}
async function apply(db,tx='100',overrides={}){
 const a=await args(db,tx,overrides);
 return (await db.query('select public.apply_native_verified_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.price,a.currency,a.revoked??false,a.signed,a.actor])).rows[0].r;
}
const count=async(db,table)=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;
const payment=async db=>(await db.query('select status,refunded_amount_jpy,voice_flea_private.verified_voice_payment(p) eligible from payments p')).rows;
const history=async(db,actor=owner,operator=false)=>(await db.query('select public.native_retry_receipt_history($1,$2) r',[actor,operator])).rows[0].r;
async function retry(db){const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);await admission(db,'client_cancel',order,a.attemptNonce);return admission(db,'retry',order,a.attemptNonce,fresh);}

for(const sameOrder of [true,false])test(`${sameOrder?'same-order':'retry-order'} duplicate partial hold never freezes or revokes winner`,async()=>{
 const db=await fixture();try{
  if(!sameOrder)await retry(db);
  await apply(db,'100');const duplicate=sameOrder?order:fresh;
  await apply(db,'200',{id:duplicate});const r=await observe(db,'200',{id:duplicate});
  assert.equal(r.handled,true);assert.equal(r.receiptClassification,'excess_payment_review');assert.equal(r.reviewRequired,true);assert.equal(r.fulfillmentGranted,false);assert.equal(r.paymentId,undefined);assert.equal(r.revoked,false);
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),0);
  await apply(db,'200',{id:duplicate,signed:'stale-positive-duplicate'});
  await apply(db,'200',{id:duplicate,revoked:true,signed:'verified-full-duplicate'});
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  assert.equal(await count(db,'conversations'),1);
  assert.equal((await history(db)).receipts.find(x=>x.transaction_id==='200').refund_review_required,true);
 }finally{await db.close();}
});
for(const evidence of [partial,{...partial,refundEvidenceVersion:null},{...partial,refundEvidenceVersion:91,revocationType:'FUTURE_VALUE'},{refundEvidenceVersion:1,revocationDate:null,revocationType:'REFUND_PRORATED',revocationPercentage:1}])test(`first ambiguous observation never grants, including version ${evidence.refundEvidenceVersion} date ${evidence.revocationDate}`,async()=>{
 const db=await fixture();try{
  const a=await admission(db,'register');await admission(db,'begin',order,a.attemptNonce);
  const r=await observe(db,'100',{evidence});assert.equal(r.receiptClassification,'refund_review_unfulfilled');assert.equal(r.revoked,false);assert.equal(r.fulfillmentGranted,false);
  assert.equal(await count(db,'payments'),0);assert.equal(await count(db,'conversations'),0);
  const positive=await apply(db,'100',{signed:'stale-original-positive'});assert.equal(positive.reviewRequired,true);assert.equal(positive.fulfillmentGranted,false);
  assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,null);
  const full=await apply(db,'100',{revoked:true,signed:'current-full-refund'});assert.equal(full.receiptClassification,'refunded_unfulfilled');assert.equal(full.revoked,true);assert.equal(full.reviewRequired,true);
  assert.equal((await apply(db,'100')).revoked,true);assert.equal(await count(db,'payments'),0);
  assert.equal((await history(db)).receipts[0].refund_review_required,true);
  await assert.rejects(db.query('insert into voice_flea_private.account_deletions(user_id) values($1)',[owner]),/refund review/);
 }finally{await db.close();}
});
test('winner hold retains exact payment identity, blocks eligibility, survives stale positive and full refund without promotion',async()=>{
 const db=await fixture();try{
  const win=await apply(db,'100');await apply(db,'200');const held=await observe(db,'100');
  assert.equal(held.receiptClassification,'winner');assert.equal(held.paymentId,win.paymentId);assert.equal(held.reviewRequired,true);assert.equal(held.revoked,false);
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
  assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),1);
  const stale=await apply(db,'100',{signed:'stale-paid'});assert.equal(stale.reviewRequired,true);assert.equal(stale.fulfillmentGranted,false);
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
  const full=await apply(db,'100',{revoked:true,signed:'full-winner-refund'});assert.equal(full.revoked,true);assert.equal(full.reviewRequired,true);
  assert.deepEqual(await payment(db),[{status:'refunded',refunded_amount_jpy:1000,eligible:false}]);
  assert.equal((await apply(db,'100',{signed:'older-paid'})).revoked,true);
  const extra=await apply(db,'300');assert.equal(extra.receiptClassification,'excess_payment_review');assert.equal(await count(db,'payments'),1);
  assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,'100');
  assert.equal((await db.query('select voice_flea_private.verified_voice_refund(p) eligible from payments p')).rows[0].eligible,false);
 }finally{await db.close();}
});
test('unsupported version holds exact winner through existing financial eligibility without fabricating a full refund',async()=>{
 const db=await fixture();try{await apply(db);await observe(db,'100',{evidence:{...partial,refundEvidenceVersion:null}});
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
  assert.equal((await db.query('select evidence from voice_flea_private.apple_refund_review_holds')).rows[0].evidence.refundEvidenceVersion,null);
 }finally{await db.close();}
});
for(const target of ['winner','duplicate','first'])test(`boost ${target}: ambiguous proof stores review without changing an existing service or granting anew`,async()=>{
 const db=await fixture('boost');try{
  if(target!=='first')await apply(db,'100');
  const tx=target==='duplicate'?'200':'100';
  if(target==='duplicate')await apply(db,tx);
  const before=(await db.query('select * from listing_boosts')).rows;
  const r=await observe(db,tx);assert.equal(r.reviewRequired,true);assert.equal(r.revoked,false);
  await apply(db,tx,{signed:'stale-positive'});
  assert.deepEqual((await db.query('select * from listing_boosts')).rows,before);
  assert.equal(await count(db,'payments'),0);assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),0);
  await apply(db,tx,{revoked:true,signed:'full-revocation'});
  const rows=(await db.query('select status from listing_boosts')).rows;
  assert.deepEqual(rows,target==='first'?[]:[{status:target==='winner'?'cancelled':'active'}]);
  assert.equal((await apply(db,tx)).revoked,true);
 }finally{await db.close();}
});
test('all exact signed variants and observed refund fields survive duplicates and reordered evidence',async()=>{
 const db=await fixture();try{await apply(db);
  await observe(db,'100',{signed:'partial-A'});await observe(db,'100',{signed:'partial-A'});
  await observe(db,'100',{signed:'unknown-B',evidence:{...partial,refundEvidenceVersion:2,revocationPercentage:12000}});
  await apply(db,'100',{signed:'stale-positive-C'});await apply(db,'100',{revoked:true,signed:'full-D'});await observe(db,'100',{signed:'partial-A'});
  const evidence=(await db.query('select signed_transaction,evidence from voice_flea_private.native_refund_observation_evidence order by id')).rows;
  assert.deepEqual(evidence.map(x=>x.signed_transaction),['partial-A','unknown-B']);assert.equal(evidence[1].evidence.revocationPercentage,12000);
  const proofs=(await db.query('select signed_transaction from voice_flea_private.native_verified_receipt_evidence order by id')).rows.map(x=>x.signed_transaction);
  assert.deepEqual(proofs,['synthetic-jws-100','partial-A','unknown-B','stale-positive-C','full-D']);
  assert.equal((await db.query('select revoked from voice_flea_private.native_verified_receipts')).rows[0].revoked,true);
 }finally{await db.close();}
});
test('observer binds owner, environment, quote, purchase time and immutable receipt identity; no missing-price synthesis',async()=>{
 const db=await fixture();try{await retry(db);await observe(db);
  for(const override of [{actor:seller},{env:'Production'},{sku:'wrong'},{price:1},{price:null},{currency:null},{currency:'USD'},{signed:''},{signed:'x'.repeat(30001)},{purchased:null},{purchased:new Date('2000-01-01')},{purchased:new Date('2099-01-01')}])await assert.rejects(observe(db,'101',override),/mismatch/);
  await assert.rejects(observe(db,'100',{id:fresh}),/already assigned/);
  for(const override of [{actor:seller},{env:'Production'},{sku:'wrong'},{price:1},{price:null},{currency:'USD'},{signed:''},{id:fresh},{purchased:new Date('2000-01-01')}])await assert.rejects(apply(db,'100',override),/mismatch|assigned/);
  for(const evidence of [{},{refundEvidenceVersion:1},{...partial,revocationDate:'NaN'},{...partial,revocationDate:0},{...partial,revocationDate:-1},{...partial,revocationDate:1e30}])await assert.rejects(observe(db,'101',{evidence}),/required|Invalid/);
  assert.equal(await count(db,'voice_flea_private.native_verified_receipts'),1);assert.equal(await count(db,'payments'),0);
 }finally{await db.close();}
});
test('service-only observation and gate deny private grants, raw evidence reads and direct hold release',async()=>{
 const db=await fixture();try{await db.exec('set role service_role');await observe(db);await apply(db);
  await assert.rejects(db.query("select voice_flea_private.apply_native_verified_receipt($1,'100',$2,'Sandbox',now(),1000000,'JPY',false,'bypass',$3)",[order,sku,owner]),/permission denied/);
  await assert.rejects(db.query('delete from voice_flea_private.native_refund_review_holds'),/permission denied/);
  await db.exec('reset role;set role authenticated');await assert.rejects(observe(db),/permission denied/);await assert.rejects(apply(db),/permission denied/);
  for(const table of ['native_refund_review_holds','native_refund_observation_evidence','native_verified_receipt_evidence'])await assert.rejects(db.query('select * from voice_flea_private.'+table),/permission denied/);
  await db.exec('reset role;set role anon');await assert.rejects(observe(db),/permission denied/);
 }finally{await db.close();}
});
test('owner/operator histories and participant status report holds after full refund without raw proof or money authority',async()=>{
 const db=await fixture();try{await apply(db);await observe(db);await observe(db,'200');await apply(db,'200',{revoked:true});
  assert.equal((await history(db)).receipts.length,2);assert((await history(db)).receipts.every(x=>x.refund_review_required));
  assert.equal((await history(db)).paymentMovementAuthorized,false);assert.equal((await history(db,other)).receipts.length,0);
  await assert.rejects(history(db,owner,true),/Operator required/);assert.equal((await history(db,seller,true)).receipts.length,2);
  assert(!JSON.stringify(await history(db)).includes('synthetic-jws'));
  for(const actor of [owner,seller,other]){await db.exec(`set role authenticated;set request.jwt.claim.sub='${actor}'`);
   const r=(await db.query('select public.apple_refund_review_status() r')).rows[0].r;assert.equal(r.count,actor===other?0:2);await db.exec('reset role');}
  for(const actor of [owner,seller]){
   assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[actor])).rows[0].pending,true);
   await assert.rejects(db.query('insert into voice_flea_private.account_deletions(user_id) values($1)',[actor]),/refund review/);
  }
  await assert.rejects(db.query('select public.native_retry_receipt_history($1,false,null,null,null)',[owner]),/Invalid reader/);
  assert.equal((await db.query('select public.native_retry_receipt_history($1,false,null,null,1) r',[owner])).rows[0].r.receipts.length,1);
 }finally{await db.close();}
});
test('unrelated legacy returns handled=false and keeps original order-bound review and successful reconciliation contracts',async()=>{
 const db=await fixture('voice','Sandbox',false);try{
  assert.deepEqual(await observe(db),{handled:false});assert.equal(await count(db,'voice_flea_private.native_refund_review_holds'),0);
  const purchase=await apply(db);assert(purchase.paymentId);assert.equal(purchase.receiptClassification,undefined);
  assert.deepEqual(await observe(db),{handled:false});
  await db.query('select public.record_apple_refund_review($1,$2,$3,$4,$5,$6,$7,$8)',[order,'100','Sandbox',sku,1000000,'JPY',partial,owner]);
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
  assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),0);
 }finally{await db.close();}
});
test('untracked legacy overlap is retained against original purpose with no grant, including stale/full followups',async()=>{
 const db=await fixture();try{
  await db.query('insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment) select $1,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment from voice_flea_private.voice_iap_orders where id=$2',[fresh,order]);
  const r=await observe(db,'200',{id:fresh,actor:null});assert.equal(r.handled,true);assert.equal(r.receiptClassification,'excess_payment_review');
  assert.equal((await db.query('select protocol_origin from voice_flea_private.native_retry_attempts where order_id=$1',[fresh])).rows[0].protocol_origin,'legacy_overlap');
  await apply(db,'200',{id:fresh});await apply(db,'200',{id:fresh,revoked:true});
  assert.equal(await count(db,'payments'),0);assert.equal((await db.query('select winner_transaction_id from voice_flea_private.native_fulfillment_intents')).rows[0].winner_transaction_id,null);
 }finally{await db.close();}
});
test('failed evidence write atomically rolls back winner hold and first-observation classification',async()=>{
 const db=await fixture();try{await apply(db);
  await db.exec("create function fail_observation() returns trigger language plpgsql as $$begin raise exception 'synthetic observation failure';end$$;create trigger fail_observation before insert on voice_flea_private.native_refund_observation_evidence for each row execute function fail_observation();");
  await assert.rejects(observe(db),/synthetic observation failure/);assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  assert.equal(await count(db,'voice_flea_private.native_refund_review_holds'),0);assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),0);
  await assert.rejects(observe(db,'200'),/synthetic observation failure/);assert.equal(await count(db,'voice_flea_private.native_verified_receipts'),1);
  await db.exec('drop trigger fail_observation on voice_flea_private.native_refund_observation_evidence');assert.equal((await observe(db)).reviewRequired,true);
 }finally{await db.close();}
});
test('winner hold blocks actual delivery, proceeds allocation and settlement claims without authorizing recovery',async()=>{
 const db=await fixture('voice','Production');try{
  const win=await apply(db);await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[win.conversationId]);
  await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[report,{rows:[{line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku,quantity:1,unitProceeds:'636.36',proceeds:'636.36',customerPrice:'1000'}]}]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await db.query('select public.allocate_apple_proceeds($1,2,$2,$3)',[report,[win.paymentId],'Verified complete purchase with exact report match.']);
  const op=(await db.query("select public.prepare_apple_settlement($1,'acct_platform') r",[win.paymentId])).rows[0].r;
  await db.exec('reset role;set role service_role');await observe(db);
  await assert.rejects(db.query('select public.claim_apple_settlement($1)',[op.id]),/refund review/);
  await assert.rejects(db.query('select public.prepare_delivery_acceptance($1,$2)',[owner,win.conversationId]),/Verified payment required/);
  await assert.rejects(db.query('select public.finalize_delivery_acceptance($1,$2)',[owner,win.conversationId]),/Verified captured payment required/);
  await apply(db,'100',{revoked:true});await assert.rejects(db.query('select public.claim_apple_recovery($1)',[op.id]),/Verified full refund/);
  await db.exec('reset role');const allocation=(await db.query('select * from voice_flea_private.apple_proceeds_allocations')).rows[0];
  await assert.rejects(db.query('insert into voice_flea_private.apple_proceeds_allocations select * from jsonb_populate_record(null::voice_flea_private.apple_proceeds_allocations,$1)',[allocation]),/refund review/);
 }finally{await db.close();}
});

test('environment+transaction identity cannot be reassigned to another owner, but separate environments are isolated',async()=>{
 const db=await fixture();try{
  await observe(db);
  await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[other,listing,fresh,'Sandbox']);await admission(db,'register',fresh,null,null,other);
  await assert.rejects(observe(db,'100',{id:fresh,actor:other}),/already assigned/);
  const different='00000000-0000-4000-8000-000000000099';
  await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[seller,boostListing,different,'Production']);await admission(db,'register',different,null,null,seller);
  const r=await observe(db,'100',{id:different,actor:seller});assert.equal(r.environment,'Production');
  assert.equal(await count(db,'voice_flea_private.native_refund_review_holds'),2);
  assert.equal((await history(db,owner)).receipts[0].environment,'Sandbox');assert.equal((await history(db,seller)).receipts[0].environment,'Production');
 }finally{await db.close();}
});
test('accepted job winner hold preserves agreed contract and blocks only its exact fulfillment eligibility',async()=>{
 const db=await fixture('job');try{
  const before=(await db.query('select agreed_price_jpy,delivery_days,status from applications')).rows;
  const win=await apply(db);await observe(db);await observe(db,'200');
  assert.equal((await db.query('select job_id from payments where id=$1',[win.paymentId])).rows[0].job_id,listing);
  assert.deepEqual((await db.query('select agreed_price_jpy,delivery_days,status from applications')).rows,before);
  assert.equal(await count(db,'payments'),1);assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
 }finally{await db.close();}
});
test('invalid legacy-overlap proof rolls back implicit attempt adoption and cannot retain fabricated quote evidence',async()=>{
 const db=await fixture();try{
  await db.query('insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment) select $1,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment from voice_flea_private.voice_iap_orders where id=$2',[fresh,order]);
  await assert.rejects(observe(db,'200',{id:fresh,price:null}),/mismatch/);
  assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),1);assert.equal(await count(db,'voice_flea_private.native_verified_receipts'),0);
  await observe(db,'200',{id:fresh});assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),2);
 }finally{await db.close();}
});
test('failed full-refund grant mutation rolls back receipt revocation and proof while preserving prior review',async()=>{
 const db=await fixture();try{
  await apply(db);await observe(db,'100',{signed:'partial-first'});
  await db.exec("create function fail_full_refund() returns trigger language plpgsql as $$begin raise exception 'synthetic full refund failure';end$$;create trigger fail_full_refund before update on payments for each row execute function fail_full_refund();");
  await assert.rejects(apply(db,'100',{revoked:true,signed:'full-fails'}),/synthetic full refund failure/);
  assert.equal((await db.query('select revoked from voice_flea_private.native_verified_receipts')).rows[0].revoked,false);
  assert.equal((await db.query("select count(*)::int n from voice_flea_private.native_verified_receipt_evidence where signed_transaction='full-fails'")).rows[0].n,0);
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
 }finally{await db.close();}
});
test('first fully revoked receipt keeps Stage1 no-grant behavior, and only a distinct verified positive can win',async()=>{
 const db=await fixture();try{
  assert.equal((await apply(db,'100',{revoked:true})).receiptClassification,'refunded_unfulfilled');
  assert.equal((await apply(db,'100',{signed:'older-positive'})).revoked,true);assert.equal(await count(db,'payments'),0);
  assert.equal((await apply(db,'200')).receiptClassification,'winner');assert.equal(await count(db,'payments'),1);
  assert.equal(await count(db,'voice_flea_private.native_refund_review_holds'),0);
 }finally{await db.close();}
});

test('late duplicate review leaves terminal winner settled; exact winner review invalidates only that financial completion',async()=>{
 const db=await fixture('voice','Production');try{
  const win=await apply(db);await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[win.conversationId]);
  await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[report,{rows:[{line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku,quantity:1,unitProceeds:'636.36',proceeds:'636.36',customerPrice:'1000'}]}]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await db.query('select public.allocate_apple_proceeds($1,2,$2,$3)',[report,[win.paymentId],'Verified purchase matches the report.']);
  const op=(await db.query("select public.prepare_apple_settlement($1,'acct_platform') r",[win.paymentId])).rows[0].r;
  await db.exec('reset role;set role service_role');await db.query('select public.claim_apple_settlement($1)',[op.id]);
  await db.query('select public.record_apple_settlement($1,$2)',[op.id,{id:'tr_apple',object:'transfer',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,amount_reversed:0,reversed:false,transfer_group:'apple_settlement_'+op.id,metadata:{apple_settlement_id:op.id,payment_id:op.payment_id}}]);
  const summary={kind:'bank',paymentId:win.paymentId,transferId:'tr_apple',destination:'acct_seller',payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'statement-ref',receivedDate:'2026-11-01',payoutAmountJpy:541,receivedAmountJpy:541,sellerAmountJpy:541,creditFeeJpy:0,creditNetJpy:541,batchAllPositiveNoFees:true,batchMatchesPayout:true,batchNetTotalJpy:541,eligibleForSettlement:true};
  const observation={transfer:{data:{id:summary.transferId,metadata:{payment_id:win.paymentId}}},payout:{data:{id:summary.payoutId},context:{accountId:summary.destination,source:'stripe_server_api'}}};
  const preview=(await db.query('select public.store_apple_financial_review($1,$2,$3,$4,$5,$6,$7) r',[seller,'00000000-0000-4000-8000-000000000071','bank',win.paymentId,{paymentId:win.paymentId},summary,observation])).rows[0].r;
  await db.query('select public.approve_apple_financial_review($1,$2,$3,$4,$5)',[seller,preview.id,preview.preview_hash,summary,observation]);
  await db.exec('reset role');assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'settled');
  await observe(db,'200');assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'settled');
  await observe(db,'100');assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'needs_review');
  assert.equal((await db.query('select state from voice_flea_private.apple_proceeds_allocations')).rows[0].state,'adjustment_required');
  assert.equal((await db.query('select state from voice_flea_private.apple_bank_receipts')).rows[0].state,'operator_approved');
  assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
 }finally{await db.close();}
});
