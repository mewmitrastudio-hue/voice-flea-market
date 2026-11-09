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
async function fixture(kind='voice',env='Sandbox',register=false,install=true){
 const db=await jobDatabase();await db.exec(`
 create table voice_flea_private.account_deletions(user_id uuid primary key,completed_at timestamptz);
 create table voice_flea_private.moderators(user_id uuid primary key);insert into voice_flea_private.moderators values('${seller}');
 create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${seller}'::uuid$$;
 create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 insert into listings(id,seller_id,price_jpy,is_active,title) values('${boostListing}','${owner}',1000,true,'Own listing');
 update voice_flea_private.voice_iap_products set sandbox_enabled=true,production_enabled=true;`);
 for(const n of ['20261028020000_priced_boost_receipts.sql','20261029033154_apple_proceeds_allocation_ledger.sql','20261102003116_keep_allocated_apple_proceeds_pending.sql','20261102020226_guard_apple_refund_settlement_on_deletion.sql','20261102040116_apple_settlement_dispatch_journal.sql','20261102055040_apple_refund_recovery_journal.sql','20261102140552_apple_refund_review_holds.sql','20261102142155_apple_financial_resolution_audit.sql','20261109010000_dual_iap_preparation.sql','20261109020000_native_purchase_attempts.sql','20261109030000_native_purchase_retry_intents.sql','20261109040000_native_refund_observations.sql','20261109050000_native_submitted_receipt_evidence.sql','20261109060000_legacy_refund_observations.sql'])if(install||n!=='20261109060000_legacy_refund_observations.sql')await db.exec(read(n));
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
  ??(await db.query('select product_id,environment,created_at,amount_jpy from voice_flea_private.voice_iap_orders where id=$1',[id])).rows[0]
  ??(await db.query("select product_id,environment,created_at,case plan when 'silver' then 300 when 'gold' then 800 else 1500 end amount_jpy from voice_flea_private.boost_orders where id=$1",[id])).rows[0];
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

const unknown={refundEvidenceVersion:null,revocationDate:null,revocationType:'REFUND_PRORATED',revocationPercentage:50000};
const legacyHistory=async(db,actor=owner,operator=false)=>(await db.query('select public.legacy_refund_receipt_history($1,$2) r',[actor,operator])).rows[0].r;
const retain=(db,tx,proof,id=order,actor=owner,env='Sandbox')=>db.query('select public.retain_native_verified_evidence($1,$2,$3,$4,$5) r',[actor,id,tx,env,proof]);
async function oldAlias(db,kind,tx='100',overrides={}){const a=await args(db,tx,overrides);
 if(kind==='voice')return (await db.query('select public.apply_verified_apple_voice($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.price,a.currency,a.revoked??false,a.actor])).rows[0].r;
 if(kind==='boost')return (await db.query('select public.apply_verified_apple_boost($1,$2,$3,$4,$5,$6) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.revoked??false])).rows[0].r;
 if(kind==='priced')return (await db.query('select public.apply_priced_apple_boost($1,$2,$3,$4,$5,$6,$7,$8) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.revoked??false,a.price,a.currency])).rows[0].r;
 return (await db.query('select public.apply_owned_priced_apple_boost($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[a.id,a.tx,a.sku,a.env,a.purchased,a.revoked??false,a.price,a.currency,a.actor])).rows[0].r;
}
for(const kind of ['voice','job','boost'])for(const state of ['first','winner','duplicate'])test(`legacy ${kind} ${state}: unsupported/date-missing signed review persists across positive/full replays without winner poisoning`,async()=>{
 const db=await fixture(kind);try{
  if(state!=='first')await apply(db,'100');const tx=state==='duplicate'?'200':'100';
  const services=(await db.query('select * from listing_boosts')).rows;
  const r=await observe(db,tx,{evidence:unknown,actor:null});assert.equal(r.handled,true);assert.equal(r.observationProtocol,'legacy');assert.equal(r.receiptClassification,undefined);assert.equal(r.intentId,undefined);assert.equal(r.legacyClassification,state==='first'?'unfulfilled_review':state==='winner'?'winner_review':'excess_payment_review');
  assert.equal(r.revoked,false);assert.equal(r.fulfillmentGranted,false);assert.equal(r.reviewRequired,true);
  assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),0);assert.equal(await count(db,'voice_flea_private.native_verified_receipts'),0);
  const positive=await apply(db,tx,{signed:'byid-positive-current'});assert.equal(positive.reviewRequired,true);assert.equal(positive.fulfillmentGranted,false);
  await retain(db,tx,'additional-submitted');
  assert.deepEqual((await db.query('select * from listing_boosts')).rows,services);
  if(kind!=='boost')assert.deepEqual(await payment(db),state==='first'?[]:[{status:'paid',refunded_amount_jpy:0,eligible:state!=='winner'}]);
  assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),state==='winner'&&kind!=='boost'?1:0);
  const full=await apply(db,tx,{revoked:true,signed:'full-verified'});assert.equal(full.revoked,true);assert.equal(full.reviewRequired,true);
  if(kind!=='boost')assert.deepEqual(await payment(db),state==='first'?[]:[{status:state==='winner'?'refunded':'paid',refunded_amount_jpy:state==='winner'?1000:0,eligible:state!=='winner'}]);
  else assert.deepEqual((await db.query('select status from listing_boosts')).rows,state==='first'?[]:[{status:state==='winner'?'cancelled':'active'}]);
  assert.equal((await apply(db,tx,{signed:'stale-positive-again'})).revoked,true);
  await observe(db,tx,{evidence:partial,signed:'older-partial-again'});assert.equal((await legacyHistory(db)).receipts[0].revoked,true);
  const signed=(await db.query('select signed_transaction from voice_flea_private.legacy_apple_refund_evidence order by id')).rows.map(x=>x.signed_transaction);
  assert.deepEqual(signed,['synthetic-jws-'+tx,'byid-positive-current','additional-submitted','full-verified','stale-positive-again','older-partial-again']);
 }finally{await db.close();}
});
for(const alias of ['voice','boost','priced','owned'])test(`${alias} old direct grant alias cannot bypass a legacy exact-tx hold, including full no-grant first observation`,async()=>{
 const db=await fixture(alias==='voice'?'voice':'boost');try{
  await observe(db,'100',{evidence:unknown});await assert.rejects(oldAlias(db,alias),/APPLE_REFUND_REVIEW_HELD/);
  const full=await oldAlias(db,alias,'100',{revoked:true});assert.equal(full.revoked,true);assert.equal(full.reviewRequired,true);
  assert.equal(await count(db,'payments'),0);assert.equal(await count(db,'listing_boosts'),0);assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),0);
  await assert.rejects(oldAlias(db,alias),/APPLE_REFUND_REVIEW_HELD/);
 }finally{await db.close();}
});
for(const kind of ['voice','boost'])test(`legacy ${kind} held first tx does not consume/freeze a different late same-order winner; future prepare and launch are barred`,async()=>{
 const db=await fixture(kind);try{
  await observe(db,'100',{evidence:unknown});const original=await args(db,'100');
  await assert.rejects(admission(db,'register'),/Legacy refund purpose/);
  await assert.rejects(db.query('select public.native_purchase_attempt($1,$2,$3,$4,$5,$6,null,$7)',[owner,'begin',order,original.sku,original.env,original.price/1000,fresh]),/APPLE_REFUND_REVIEW_HELD/);
  if(kind==='voice')await assert.rejects(db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[owner,listing,fresh,'Sandbox']),/APPLE_REFUND_REVIEW_HELD/);
  else await assert.rejects(db.query("select public.prepare_boost_order_in_environment($1,$2,'gold','Sandbox')",[owner,boostListing]),/APPLE_REFUND_REVIEW_HELD/);
  const win=await apply(db,'200');assert.equal(win.reviewRequired,undefined);assert.equal(await count(db,kind==='voice'?'payments':'listing_boosts'),1);
  await observe(db,'100',{evidence:unknown});assert.equal((await legacyHistory(db)).receipts[0].classification,'excess_payment_review');
  await apply(db,'100',{revoked:true});assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),0);
  if(kind==='voice')assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  else assert.equal((await db.query('select status from listing_boosts')).rows[0].status,'active');
 }finally{await db.close();}
});
test('legacy job review blocks prepare by accepted application without changing existing agreed terms',async()=>{
 const db=await fixture('job');try{await observe(db,'100',{evidence:unknown});
  await assert.rejects(db.query('select public.prepare_job_voice_iap_order($1,$2,$3,$4)',[owner,fresh,'00000000-0000-4000-8000-000000000099','Sandbox']),/APPLE_REFUND_REVIEW_HELD/);
  assert.equal((await db.query('select agreed_price_jpy from applications')).rows[0].agreed_price_jpy,1000);
 }finally{await db.close();}
});
test('legacy held purpose rejects new changed-price v3 registration/adoption, but unrelated legacy purchases remain unchanged',async()=>{
 const db=await fixture();try{
  await observe(db,'100',{evidence:unknown});
  // Exceptional old prepared quote predates this review; this is not a prepare bypass.
  await db.query('insert into voice_flea_private.voice_iap_orders(id,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment) select $1,buyer_id,seller_id,listing_id,product_id,amount_jpy,environment from voice_flea_private.voice_iap_orders where id=$2',[fresh,order]);
  await assert.rejects(admission(db,'register',fresh),/Legacy refund purpose/);
  // Simulate an independently pre-existing intent so receipt-side adoption is tested too.
  await db.query("insert into voice_flea_private.native_fulfillment_intents(owner_id,kind,subject_id,environment) values($1,'voice_listing',$2,'Sandbox')",[owner,listing]);
  await assert.rejects(apply(db,'300',{id:fresh}),/Legacy refund purpose/);
  await assert.rejects(observe(db,'300',{id:fresh,evidence:unknown}),/Legacy refund purpose/);
  assert.equal(await count(db,'voice_flea_private.native_retry_attempts'),0);assert.equal(await count(db,'payments'),0);
  const unrelated='00000000-0000-4000-8000-000000000099';await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[other,listing,unrelated,'Sandbox']);
  assert((await apply(db,'999',{id:unrelated,actor:other})).paymentId);
 }finally{await db.close();}
});
test('cross-ledger transaction reassignment is rejected in both directions before any native winner/adoption can commit',async()=>{
 for(const nativeFirst of [true,false]){const db=await fixture();try{
  if(nativeFirst)await admission(db,'register');
  await observe(db,'100',{evidence:unknown});
  await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4)',[other,listing,fresh,'Sandbox']);
  if(!nativeFirst)await admission(db,'register',fresh,null,null,other);
  await assert.rejects(observe(db,'100',{id:fresh,actor:other,evidence:unknown}),/already assigned/);
  await assert.rejects(apply(db,'100',{id:fresh,actor:other}),/already assigned/);
  assert.equal(await count(db,'payments'),0);
 }finally{await db.close();}}
});
test('all identity/time/financial bindings remain mandatory; unsupported refund fields are retained without invented date/version',async()=>{
 const db=await fixture();try{
  await observe(db,'100',{evidence:unknown});
  for(const o of [{actor:seller},{sku:'wrong'},{env:'Production'},{price:null},{price:1},{currency:null},{currency:'USD'},{purchased:null},{purchased:new Date('2000-01-01')},{signed:''}])await assert.rejects(observe(db,'200',{evidence:unknown,...o}),/mismatch/);
  for(const o of [{actor:seller},{sku:'wrong'},{price:null},{price:1},{currency:null},{purchased:new Date('2000-01-01')},{signed:''}])await assert.rejects(apply(db,'100',o),/mismatch/);
  const facts=(await db.query('select evidence from voice_flea_private.legacy_apple_refund_evidence')).rows[0].evidence;assert.deepEqual(facts,unknown);
  for(const e of [{},{refundEvidenceVersion:1},{...partial,revocationDate:'bad'},{...partial,revocationDate:-1}])await assert.rejects(observe(db,'201',{evidence:e}),/required|Invalid/);
  assert.equal(await count(db,'voice_flea_private.legacy_apple_refund_reviews'),1);assert.equal(await count(db,'payments'),0);
 }finally{await db.close();}
});
test('exact legacy winner holds block actual delivery, allocation, settlement dispatch and full-refund recovery',async()=>{
 const db=await fixture('voice','Production');try{
  const win=await apply(db);await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[win.conversationId]);
  await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[report,{rows:[{line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku,quantity:1,unitProceeds:'636.36',proceeds:'636.36',customerPrice:'1000'}]}]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);await db.query('select public.allocate_apple_proceeds($1,2,$2,$3)',[report,[win.paymentId],'Verified complete purchase matches report.']);
  const op=(await db.query("select public.prepare_apple_settlement($1,'acct_platform') r",[win.paymentId])).rows[0].r;
  await db.exec('reset role;set role service_role');await observe(db,'100',{evidence:unknown});
  await assert.rejects(db.query('select public.claim_apple_settlement($1)',[op.id]),/refund review/);
  await assert.rejects(db.query('select public.prepare_delivery_acceptance($1,$2)',[owner,win.conversationId]),/Verified payment/);
  await apply(db,'100',{revoked:true});await assert.rejects(db.query('select public.claim_apple_recovery($1)',[op.id]),/Verified full refund/);
  await db.exec('reset role');const allocation=(await db.query('select * from voice_flea_private.apple_proceeds_allocations')).rows[0];
  await assert.rejects(db.query('insert into voice_flea_private.apple_proceeds_allocations select * from jsonb_populate_record(null::voice_flea_private.apple_proceeds_allocations,$1)',[allocation]),/refund review/);
 }finally{await db.close();}
});
test('legacy participant status and bounded owner/operator queue preserve unresolved review after full refund without proof exposure',async()=>{
 const db=await fixture();try{await apply(db);await observe(db);await observe(db,'200',{evidence:unknown});await apply(db,'200',{revoked:true});
  assert.equal((await legacyHistory(db)).receipts.length,2);assert.equal((await legacyHistory(db)).paymentMovementAuthorized,false);
  assert.equal((await legacyHistory(db,other)).receipts.length,0);await assert.rejects(legacyHistory(db,owner,true),/Operator required/);assert.equal((await legacyHistory(db,seller,true)).receipts.length,2);
  assert(!JSON.stringify(await legacyHistory(db)).includes('synthetic-jws'));
  for(const user of [owner,seller,other]){await db.exec(`set role authenticated;set request.jwt.claim.sub='${user}'`);assert.equal((await db.query('select public.apple_refund_review_status() r')).rows[0].r.count,user===other?0:2);await db.exec('reset role');}
  for(const user of [owner,seller])await assert.rejects(db.query('insert into voice_flea_private.account_deletions(user_id) values($1)',[user]),/refund review/);
  for(const limit of [null,0,101])await assert.rejects(db.query('select public.legacy_refund_receipt_history($1,false,null,null,$2)',[owner,limit]),/Invalid reader/);
  assert.equal((await db.query('select public.legacy_refund_receipt_history($1,false,null,null,1) r',[owner])).rows[0].r.receipts.length,1);
 }finally{await db.close();}
});
test('service-only ACL blocks raw evidence reads and all newly moved grant/admission bypasses',async()=>{
 const db=await fixture();try{await db.exec('set role service_role');await observe(db,'100',{evidence:unknown});await retain(db,'100','another-proof');
  for(const name of ['apply_legacy_apple_voice_before_refund_review','apply_legacy_apple_voice'])await assert.rejects(db.query(`select voice_flea_private.${name}($1,'100',$2,'Sandbox',now(),1000000,'JPY',false,$3)`,[order,sku,owner]),/permission denied/);
  await assert.rejects(db.query('select voice_flea_private.native_retry_admission_before_legacy_refund($1,$2,$3)',[owner,'register',order]),/permission denied/);
  await assert.rejects(db.query('select voice_flea_private.prepare_voice_iap_order_before_legacy_refund($1,$2,$3,$4)',[owner,listing,fresh,'Sandbox']),/permission denied/);
  await assert.rejects(db.query('delete from voice_flea_private.legacy_apple_refund_reviews'),/permission denied/);
  await db.exec('reset role;set role authenticated');await assert.rejects(observe(db),/permission denied/);await assert.rejects(retain(db,'100','forbidden'),/permission denied/);await assert.rejects(legacyHistory(db),/permission denied/);
  await assert.rejects(db.query('select * from voice_flea_private.legacy_apple_refund_evidence'),/permission denied/);
 }finally{await db.close();}
});
test('failed legacy evidence insertion rolls back exact winner hold and first observation atomically',async()=>{
 const db=await fixture();try{await apply(db);
  await db.exec("create function fail_legacy_evidence() returns trigger language plpgsql as $$begin raise exception 'synthetic legacy evidence failure';end$$;create trigger fail_legacy_evidence before insert on voice_flea_private.legacy_apple_refund_evidence for each row execute function fail_legacy_evidence();");
  await assert.rejects(observe(db,'100',{evidence:unknown}),/synthetic legacy evidence failure/);
  assert.equal(await count(db,'voice_flea_private.apple_refund_review_holds'),0);assert.equal(await count(db,'voice_flea_private.legacy_apple_refund_reviews'),0);assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  await assert.rejects(observe(db,'200',{evidence:unknown}),/synthetic legacy evidence failure/);assert.equal(await count(db,'voice_flea_private.legacy_apple_refund_reviews'),0);
 }finally{await db.close();}
});
test('existing native winner/excess observation and native additional-proof append behavior remains unchanged',async()=>{
 const db=await fixture('voice','Sandbox',true);try{
  await apply(db,'100');await apply(db,'200');assert.equal((await observe(db,'200',{evidence:unknown})).receiptClassification,'excess_payment_review');
  await retain(db,'200','native-extra-proof');await apply(db,'200',{revoked:true});assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:true}]);
  await observe(db,'100',{evidence:unknown});await apply(db,'100',{revoked:true});assert.deepEqual(await payment(db),[{status:'refunded',refunded_amount_jpy:1000,eligible:false}]);
  assert.equal(await count(db,'voice_flea_private.legacy_apple_refund_reviews'),0);
 }finally{await db.close();}
});

test('migration preserves original grant/observer/admission/prepare OIDs and prewarmed callers cannot bypass new holds',async()=>{
 const db=await fixture('voice','Sandbox',false,false);try{
  const names=['apply_legacy_apple_voice','apply_legacy_apple_boost','record_native_refund_observation','native_retry_admission','native_purchase_attempt','prepare_voice_iap_order','prepare_job_voice_iap_order','prepare_boost_order_in_environment','apply_native_verified_receipt','retain_native_verified_evidence'];
  const oids=async()=> (await db.query("select n.nspname,p.proname,p.oid::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname=any($1) and n.nspname in ('public','voice_flea_private') order by n.nspname,p.proname",[names])).rows;
  const before=await oids();await oldAlias(db,'voice');await apply(db); // Warm both direct and central legacy callers.
  await db.exec(read('20261109060000_legacy_refund_observations.sql'));assert.deepEqual(await oids(),before);
  await observe(db,'100',{evidence:unknown});await assert.rejects(oldAlias(db,'voice'),/APPLE_REFUND_REVIEW_HELD/);
  assert.equal((await apply(db)).reviewRequired,true);assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
 }finally{await db.close();}
});

test('legacy late duplicate review leaves terminal winner settled; exact winner review invalidates only that financial completion',async()=>{
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

test('failed exact-winner full followup rolls back ledger revocation and payment while keeping original hold',async()=>{
 const db=await fixture();try{await apply(db);await observe(db,'100',{evidence:unknown});
  await db.exec("create function fail_legacy_full() returns trigger language plpgsql as $$begin raise exception 'synthetic full failure';end$$;create trigger fail_legacy_full before update on payments for each row execute function fail_legacy_full();");
  await assert.rejects(apply(db,'100',{revoked:true,signed:'full-failed'}),/synthetic full failure/);
  assert.equal((await legacyHistory(db)).receipts[0].revoked,false);assert.deepEqual(await payment(db),[{status:'paid',refunded_amount_jpy:0,eligible:false}]);
  assert.equal((await db.query("select count(*)::int n from voice_flea_private.legacy_apple_refund_evidence where signed_transaction='full-failed'")).rows[0].n,0);
 }finally{await db.close();}
});
