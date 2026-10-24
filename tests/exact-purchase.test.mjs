import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',stranger='00000000-0000-4000-8000-000000000003';
const purchase='00000000-0000-4000-8000-000000000004',listing='00000000-0000-4000-8000-000000000005';
const migration=fs.readFileSync(new URL('../supabase/migrations/20261024095131_exact_purchase_conversation_and_fee_policy.sql',import.meta.url),'utf8');
async function database(){const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;create schema auth;create schema voice_flea_private;
 grant usage on schema auth,voice_flea_private to authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null$$;
 create table payments(id uuid primary key,listing_id uuid,buyer_id uuid,seller_id uuid,status text,stripe_reconciled_at timestamptz,stripe_livemode boolean,refunded_amount_jpy integer);
 insert into payments values('${purchase}','${listing}','${buyer}','${seller}','paid',now(),false,0);
 create table user_blocks(blocker_id uuid,blocked_user_id uuid);
 create table conversations(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,job_id uuid,is_inquiry boolean default false,delivery_status text default 'none');
 alter table conversations enable row level security;grant select,insert,update on conversations to authenticated;
 create policy own on conversations to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid()) with check(buyer_id=auth.uid() or seller_id=auth.uid());
 `);await db.exec(migration);return db;}
test('exact purchase links survive repeated and interleaved opens; other users and malformed associations are denied',async()=>{
 const db=await database();try{
  assert.equal((await db.query("select has_function_privilege('anon','public.open_paid_purchase_conversation(uuid)','execute') ok")).rows[0].ok,false);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${stranger}'`);
  await assert.rejects(db.query('select public.open_paid_purchase_conversation($1)',[purchase]),/Purchase unavailable/);
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);
  const open=async id=>(await db.query('select public.open_paid_purchase_conversation($1) c',[id])).rows[0].c;
  const first=await open(purchase);assert.equal(first.payment_id,purchase);assert.equal((await open(purchase)).id,first.id);
  const another='00000000-0000-4000-8000-000000000006';await db.exec(`reset role;insert into payments select '${another}',listing_id,buyer_id,seller_id,status,stripe_reconciled_at,stripe_livemode,refunded_amount_jpy from payments where id='${purchase}';set role authenticated;`);
  const second=await open(another);assert.notEqual(first.id,second.id);assert.equal((await open(purchase)).id,first.id);
  await db.query('update conversations set listing_id=null where id=$1',[second.id]);
  await db.query('update conversations set listing_id=$1 where id=$2',[listing,second.id]);
  await assert.rejects(db.query('update conversations set payment_id=null where id=$1',[first.id]),/cannot change/);
  await assert.rejects(db.query('insert into conversations(listing_id,buyer_id,seller_id,payment_id) values($1,$2,$3,$4)',[listing,seller,buyer,purchase]),/does not identify/);
  await db.exec(`reset role;update payments set status='refunded',refunded_amount_jpy=1000 where id='${another}';set role authenticated;`);
  assert.equal((await open(another)).id,second.id,'refund preserves existing trade history');
  const unverified='00000000-0000-4000-8000-000000000007';await db.exec(`reset role;insert into payments values('${unverified}','${listing}','${buyer}','${seller}','paid',null,null,null);set role authenticated;`);
  await assert.rejects(open(unverified),/Verified paid/);
 }finally{await db.close()}
});
test('approved Web and iOS split conserves every yen, keeps Apple fees unknown, and refuses invalid inputs',async()=>{
 const db=await database();try{
  const quote=async(gross,channel,apple=null)=>(await db.query('select voice_flea_private.voice_fee_allocation($1,$2,$3) q',[gross,channel,apple])).rows[0].q;
  assert.deepEqual(await quote(1000,'web'),{policy:'2026-10-24-v1',state:'allocated',basis_jpy:1000,platform_fee_jpy:150,seller_amount_jpy:850});
  assert.equal((await quote(1000,'ios')).state,'apple_fee_unconfirmed');assert.equal((await quote(1000,'ios')).seller_amount_jpy,null);
  const ios=await quote(1000,'ios',150);assert.equal(ios.basis_jpy,850);assert.equal(ios.platform_fee_jpy+ios.seller_amount_jpy+150,1000);
  for(const gross of [0,1,49,50,99,1000,999999,2147483647]){const q=await quote(gross,'web');assert.equal(q.platform_fee_jpy+q.seller_amount_jpy,gross);}
  for(const args of [[-1,'web'],[1,'invalid'],[100,'ios',101],[100,'ios',-1],[100,'web',0],[null,'web']])await assert.rejects(quote(...args),/Invalid|Unexpected/);
  await db.exec('set role authenticated');await assert.rejects(quote(1000,'ios',0),/permission denied/);
 }finally{await db.close()}
});
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function reconcileFixture({changeAccount=false,session='cs_test_current',recordSession=session,paymentStatus='paid',legacy=false,newPending=false}={}){
 const map=new Map(),queries=[],calls=[],overlay={classList:{add(){calls.push('overlay')}}};
 const pending={listingId:listing,checkoutSessionId:session,startedAt:new Date().toISOString()};if(legacy)delete pending.checkoutSessionId;
 map.set(`vf_pending_purchase_${buyer}`,JSON.stringify(pending));
 const c={currentUser:{id:buyer},safeLocalStorage:{getItem:k=>map.get(k)||null,removeItem:k=>map.delete(k)},Date,JSON,Number,document:{getElementById:id=>id==='paymentSuccessOverlay'?overlay:{}},setTimeout:fn=>fn(),listingDisplayTitle:async()=> 'Voice',go(){},openConversation(){},sb:{
  from:()=>{const q={select(){return this},eq(k,v){queries.push([k,v]);return this},async limit(){if(changeAccount)c.currentUser={id:stranger};return {data:[{id:purchase,listing_id:listing,buyer_id:buyer,seller_id:seller,stripe_checkout_session_id:recordSession,status:paymentStatus,stripe_reconciled_at:'2026-10-24',stripe_livemode:false,refunded_amount_jpy:0}]}}};return q;},
  rpc:async(name,args)=>{calls.push({name,args});if(newPending)map.set(`vf_pending_purchase_${buyer}`,JSON.stringify({...pending,checkoutSessionId:'cs_test_newer'}));return{data:{id:'conversation',payment_id:purchase},error:null};}
 }};vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function reconcilePendingPurchase(){'),html.indexOf('async function getFavoriteListingIds(){')),c);return{c,map,queries,calls};
}
test('purchase return matches only its exact Checkout and never touches another account or newer pending purchase',async()=>{
 const f=reconcileFixture();await f.c.reconcilePendingPurchase();assert.ok(f.queries.some(x=>x[0]==='stripe_checkout_session_id'&&x[1]==='cs_test_current'));assert.equal(f.calls[0].args.purchase_id,purchase);assert.equal(f.map.size,0);
 for(const options of [{changeAccount:true},{recordSession:'cs_test_other'},{paymentStatus:'refunded'},{legacy:true}]){const x=reconcileFixture(options);assert.equal(await x.c.reconcilePendingPurchase(),null);assert.equal(x.calls.length,0);assert.equal(x.map.size,1);}
 const newer=reconcileFixture({newPending:true});assert.equal(await newer.c.reconcilePendingPurchase(),null);assert.ok([...newer.map.values()][0].includes('cs_test_newer'));assert.ok(!newer.calls.includes('overlay'));
});
