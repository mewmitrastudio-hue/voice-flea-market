import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const source=read('tests/legacy-refund-observations.test.mjs');
const init=source.slice(source.indexOf('const owner='),source.indexOf('for(const kind of')).replace(/const read=n=>[^\n]+\n/,'');
const F=new Function('jobDatabase','read','assert',init+';return {fixture,observe,apply,admission,owner,seller,other,boostListing,order,fresh};')(jobDatabase,n=>read('supabase/migrations/'+n),assert);
const original=read('tests/fixtures/live-inventory/prepare_boost_order-20261109.sql');
const migration=read('supabase/migrations/20261109080000_legacy_boost_prepare_guard.sql');
async function fixture(){const db=await F.fixture('boost');await db.exec(original);await db.exec('revoke all on function public.prepare_boost_order(uuid,uuid,text) from public,anon,authenticated;grant execute on function public.prepare_boost_order(uuid,uuid,text) to service_role;');return db;}
const prepare=(db,owner=F.owner,listing=F.boostListing,plan='silver')=>db.query('select public.prepare_boost_order($1,$2,$3) r',[owner,listing,plan]).then(x=>x.rows[0].r);
const count=db=>db.query('select count(*)::int n from voice_flea_private.boost_orders').then(x=>x.rows[0].n);
const oid=db=>db.query("select 'public.prepare_boost_order(uuid,uuid,text)'::regprocedure::oid as oid").then(x=>x.rows[0].oid);
test('exact live fixture retains OID, service-only ACL, response and pending reuse; fresh environment remains null',async()=>{
 const db=await fixture();try{
  const before=await prepare(db),id=await oid(db);await db.exec(migration);const after=await prepare(db);assert.deepEqual(after,before);assert.equal(await oid(db),id);assert.equal(await count(db),1);
  const gold=await prepare(db,F.owner,F.boostListing,'gold');assert.equal(gold.productId,'com.ayuhide.koenofurima.boost.gold');assert.equal(gold.durationDays,12);assert.equal(gold.referencePriceJpy,800);
  assert.equal((await db.query('select environment from voice_flea_private.boost_orders where id=$1',[gold.orderId])).rows[0].environment,null);
  await db.exec('set role service_role');assert.equal((await prepare(db)).orderId,before.orderId);await db.exec('reset role');
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(prepare(db),/permission denied/);await db.exec('reset role');}
  assert.deepEqual((await db.query("select prosecdef,proconfig from pg_proc where oid='public.prepare_boost_order(uuid,uuid,text)'::regprocedure")).rows[0],{prosecdef:true,proconfig:['search_path=""']});
 }finally{await db.close();}
});
test('prewarmed service caller cannot bypass a newly recorded legacy review after replacement',async()=>{
 const db=await fixture();try{
  await db.exec(`create function public.compat_warm(o uuid,l uuid) returns jsonb language sql security definer set search_path='' as $$select public.prepare_boost_order(o,l,'silver')$$;`);
  await db.query('select public.compat_warm($1,$2)',[F.owner,F.boostListing]);await db.exec(migration);await F.observe(db,'100',{evidence:{revocationType:'REFUND_PRORATED',revocationPercentage:50000}});
  const n=await count(db);await assert.rejects(db.query('select public.compat_warm($1,$2)',[F.owner,F.boostListing]),/APPLE_REFUND_REVIEW_HELD/);await assert.rejects(prepare(db,F.owner,F.boostListing,'gold'),/APPLE_REFUND_REVIEW_HELD/);assert.equal(await count(db),n);
 }finally{await db.close();}
});
for(const settled of [false,true])test(`same-purpose v3 ${settled?'fulfilled':'prepared'} intent blocks old3arg without changing the existing lifecycle`,async()=>{
 const db=await fixture();try{
  await db.exec(migration);await F.admission(db,'register');if(settled){await F.apply(db,'100');await db.exec("update listing_boosts set ends_at=now()-interval '1 day'");}
  const n=await count(db);await assert.rejects(prepare(db,F.owner,F.boostListing,'gold'),/existing fulfillment intent/);assert.equal(await count(db),n);
 }finally{await db.close();}
});
test('same owner different listing and different owner remain eligible despite another purpose review/intent',async()=>{
 const db=await fixture();try{
  await db.exec(migration);await F.observe(db,'100');
  const own2='00000000-0000-4000-8000-000000000091',other2='00000000-0000-4000-8000-000000000092';
  await db.query('insert into listings(id,seller_id,price_jpy,is_active,title) values($1,$2,1000,true,$3),($4,$5,1000,true,$6)',[own2,F.owner,'Own second',other2,F.seller,'Other seller']);
  assert((await prepare(db,F.owner,own2)).orderId);assert((await prepare(db,F.seller,other2,'platinum')).orderId);
  assert.equal((await db.query('select count(*)::int n from listing_boosts')).rows[0].n,0);
 }finally{await db.close();}
});
test('legacy-only prior finished boost permits ordinary new order; owner/activity/tier/active restrictions preserved',async()=>{
 const db=await fixture();try{
  await db.exec(migration);await F.apply(db,'100');await assert.rejects(prepare(db),/Boost already active/);
  await db.exec("update listing_boosts set ends_at=now()-interval '1 day'");const next=await prepare(db);assert.notEqual(next.orderId,F.order);assert.equal((await db.query('select environment from voice_flea_private.boost_orders where id=$1',[next.orderId])).rows[0].environment,null);
  await assert.rejects(prepare(db,F.seller),/Listing unavailable/);await assert.rejects(prepare(db,F.owner,F.boostListing,'bad'),/Invalid plan/);
  await db.query('update listings set is_active=false where id=$1',[F.boostListing]);await assert.rejects(prepare(db),/Listing unavailable/);
 }finally{await db.close();}
});
test('migration refuses unreviewed definition or broader ACL before replacing old behavior',async()=>{
 const db=await fixture();try{
  await db.exec('grant execute on function public.prepare_boost_order(uuid,uuid,text) to authenticated');await assert.rejects(db.exec(migration),/privileges differ/);
  await db.exec('revoke execute on function public.prepare_boost_order(uuid,uuid,text) from authenticated');
  await db.exec(original.replace('Invalid plan','Changed plan'));await assert.rejects(db.exec(migration),/definition changed/);
 }finally{await db.close();}
});
