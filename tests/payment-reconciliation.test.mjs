import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHmac,webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const migration=fs.readFileSync(new URL('../supabase/migrations/20261024080918_payment_reconciliation.sql',import.meta.url),'utf8');
const operator='00000000-0000-4000-8000-000000000001';
const buyer='00000000-0000-4000-8000-000000000002';
const seller='00000000-0000-4000-8000-000000000003';
const listing='00000000-0000-4000-8000-000000000004';
async function database(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema voice_flea_private;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function voice_flea_private.is_moderator() returns boolean language sql stable as $$select auth.uid()='${operator}'::uuid$$;
 grant usage on schema auth,voice_flea_private to authenticated;
 create table public.listings(id uuid primary key,title text);
 insert into public.listings values('${listing}','<Voice>');
 create table public.payments(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,amount_jpy integer,
 platform_fee_jpy integer,seller_amount_jpy integer,status text,stripe_checkout_session_id text unique,stripe_payment_intent_id text unique,
 paid_at timestamptz,refunded_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
 alter table public.payments enable row level security;
 create policy own on public.payments for select to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid());
 grant select on public.payments to authenticated;grant all on public.payments to service_role;
 `);
 await db.exec(migration);return db;
}
function snapshot(overrides={}){return {stripe_payment_intent_id:'pi_test1',stripe_checkout_session_id:'cs_test_1',stripe_charge_id:'ch_test1',stripe_livemode:false,
 amount_jpy:1000,refunded_amount_jpy:0,stripe_reconciled_at:'2026-10-24T07:00:00Z',paid_at:'2026-10-20T07:00:00Z',buyer_id:buyer,seller_id:seller,listing_id:listing,...overrides};}
async function save(db,s){await db.query('select public.record_stripe_payment_snapshot($1)',[s]);}
test('Stripe snapshots preserve identities and original dates, reconcile refunds, and reject stale concurrent results',async()=>{
 const db=await database();try{
  await db.exec('set role service_role');await save(db,snapshot());
  const first=(await db.query('select * from payments')).rows[0];
  await save(db,snapshot({refunded_amount_jpy:300,stripe_reconciled_at:'2026-10-24T07:02:00Z',paid_at:'2026-10-22T00:00:00Z'}));
  await save(db,snapshot({stripe_reconciled_at:'2026-10-24T07:01:00Z'}));
  let row=(await db.query('select * from payments')).rows[0];assert.equal(row.status,'partially_refunded');assert.equal(row.refunded_amount_jpy,300);assert.equal(row.paid_at.getTime(),first.paid_at.getTime());assert.equal(row.id,first.id);
  await save(db,snapshot({stripe_reconciled_at:'2026-10-24T07:03:00Z',refunded_amount_jpy:1000}));
  assert.equal((await db.query('select status from payments')).rows[0].status,'refunded');
  await assert.rejects(save(db,snapshot({amount_jpy:1100})),/identity mismatch/);
  await assert.rejects(save(db,snapshot({stripe_livemode:true})),/identity mismatch/);
  await assert.rejects(save(db,snapshot({buyer_id:operator})),/identity mismatch/);
  await assert.rejects(save(db,snapshot({stripe_charge_id:'ch_another'})),/identity mismatch/);
  await assert.rejects(save(db,snapshot({refunded_amount_jpy:1001})),/Invalid Stripe snapshot/);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
 }finally{await db.close();}
});
test('refund before completion requests retry; failed refund can restore current Stripe amount without inventing refund dates',async()=>{
 const db=await database();try{
  await db.exec('set role service_role');
  const refund=snapshot({stripe_checkout_session_id:null,refunded_amount_jpy:300});
  await assert.rejects(save(db,refund),/Purchase snapshot required first/);
  await save(db,snapshot({refunded_amount_jpy:300}));
  await save(db,snapshot({stripe_reconciled_at:'2026-10-24T07:03:00Z',refunded_amount_jpy:0}));
  const row=(await db.query('select status,refunded_at,refunded_amount_jpy from payments')).rows[0];
  assert.deepEqual(row,{status:'paid',refunded_at:null,refunded_amount_jpy:0});
 }finally{await db.close();}
});
test('operator summaries include more than 200 records, separate unknown/test/live, and keep table RLS and write privileges',async()=>{
 const db=await database();try{
  await db.exec(`insert into payments(id,listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,stripe_checkout_session_id,stripe_payment_intent_id,stripe_livemode,refunded_amount_jpy,stripe_reconciled_at,created_at)
   select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${listing}','${buyer}','${seller}',1000,150,850,
   case when n=1 then 'refunded' when n=2 then 'partially_refunded' else 'paid' end,'cs_'||n,'pi_'||n,
   case when n<=210 then true when n<=240 then false else null end,
   case when n=1 then 1000 when n=2 then 300 when n>240 then null else 0 end,
   case when n<=240 then now() else null end,'2026-10-01T00:00:00Z' from generate_series(1,250)n;`);
  const priv=(await db.query(`select has_function_privilege('anon','public.admin_payment_receipts(timestamptz,uuid)','execute') a,has_function_privilege('authenticated','public.record_stripe_payment_snapshot(jsonb)','execute') w,(select prosecdef from pg_proc where oid='public.admin_payment_receipts(timestamptz,uuid)'::regprocedure) d`)).rows[0];
  assert.deepEqual(priv,{a:false,w:false,d:false});
  await db.exec('set role authenticated');await assert.rejects(db.query('select public.admin_payment_receipts()'),/Operator access required/);
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);await assert.rejects(db.query('select public.admin_payment_receipts()'),/Operator access required/);
  await assert.rejects(save(db,snapshot()),/permission denied/);
  await db.exec(`set request.jwt.claim.sub='${operator}'`);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  const read=async(c)=> (await db.query('select public.admin_payment_receipts($1,$2) result',[c?.created_at||null,c?.id||null])).rows[0].result;
  const first=await read();const prod=first.summary.find(x=>x.environment==='Production');
  assert.equal(prod.receipt_count,210);assert.equal(prod.verified_gross_jpy,210000);assert.equal(prod.verified_refunds_jpy,1300);assert.equal(prod.verified_retained_jpy,208700);
  assert.equal(first.summary.find(x=>x.environment==='Test').verified_gross_jpy,30000);
  const unknown=first.summary.find(x=>x.environment==='Unknown');assert.equal(unknown.unreconciled_count,10);assert.equal(unknown.verified_gross_jpy,0);
  const rows=[...first.rows];let page=first;while(page.has_more){page=await read(page.rows.at(-1));rows.push(...page.rows);}
  assert.equal(rows.length,250);assert.equal(new Set(rows.map(x=>x.id)).size,250);
  await assert.rejects(db.query('select public.admin_payment_receipts(now(),null)'),/Incomplete cursor/);
 }finally{await db.close();}
});

const source=fs.readFileSync(new URL('../supabase/functions/stripe-webhook/index.ts',import.meta.url),'utf8');
function webhook({chargeOverrides={},piOverrides={},rpcError=false}={}){
 const calls=[];let handler;let gets=0;
 const env={STRIPE_WEBHOOK_SECRET:'whsec_unit_test',STRIPE_SECRET_KEY:'sk_test_unit_test',SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only'};
 const context={Response,Request,TextEncoder,Uint8Array,Date,JSON,crypto:webcrypto,console:{error(){}},
  Deno:{env:{get:k=>env[k]},serve:fn=>{handler=fn}},
  createClient:()=>({rpc:async(name,args)=>{calls.push({name,args});return{error:rpcError?{message:'storage failure'}:null}}}),
  fetch:async()=>{gets++;return Response.json({id:'pi_test1',livemode:false,status:'succeeded',currency:'jpy',amount:1000,
   latest_charge:{id:'ch_test1',livemode:false,payment_intent:'pi_test1',currency:'jpy',amount:1000,amount_captured:1000,amount_refunded:300,paid:true,captured:true,...chargeOverrides},...piOverrides})},
 };
 vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*\n/,'')),context);
 const send=async(event,{invalidSignature=false}={})=>{
  const raw=JSON.stringify(event);const t=Math.floor(Date.now()/1000);
  const sig=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return handler(new Request('https://local.invalid/webhook',{method:'POST',body:raw,headers:{'stripe-signature':`t=${t},v1=${invalidSignature?'0'.repeat(64):sig}`}}));
 };
 return{send,calls,gets:()=>gets};
}
function event(overrides={}){return{id:'evt_unit',livemode:false,created:1792825200,type:'checkout.session.completed',data:{object:{id:'cs_test_1',livemode:false,payment_status:'paid',currency:'jpy',amount_total:1000,payment_intent:'pi_test1',metadata:{listing_id:listing,buyer_id:buyer,seller_id:seller,reservation_id:'reservation'}}},...overrides};}
test('signed paid completion reconciles captured Stripe amounts before releasing reservation',async()=>{
 const h=webhook();assert.equal((await h.send(event())).status,200);
 assert.deepEqual(h.calls.map(x=>x.name),['record_stripe_payment_snapshot','finish_checkout_reservation']);
 const s=h.calls[0].args.snapshot;assert.equal(s.refunded_amount_jpy,300);assert.equal(s.stripe_livemode,false);assert.equal(s.buyer_id,buyer);assert.equal(s.paid_at,new Date(event().created*1000).toISOString());
});
test('unauthenticated, wrong-mode, unpaid and uncaptured events never create paid records',async()=>{
 const h=webhook();assert.equal((await h.send(event(),{invalidSignature:true})).status,400);
 assert.equal((await h.send(event({livemode:true}))).status,400);
 const unpaid=event();unpaid.data.object.payment_status='unpaid';assert.equal((await h.send(unpaid)).status,200);assert.equal(h.calls.length,0);assert.equal(h.gets(),0);
 for(const options of [{chargeOverrides:{captured:false}},{chargeOverrides:{amount_captured:700}},{piOverrides:{status:'requires_capture'}},{chargeOverrides:{livemode:true}},{chargeOverrides:{amount_refunded:1001}}]){
  const bad=webhook(options);assert.equal((await bad.send(event())).status,503);assert.equal(bad.calls.length,0);
 }
});
test('out-of-order refund events use current Stripe state and persistence failures request retry',async()=>{
 const e=event({type:'refund.failed',data:{object:{payment_intent:'pi_test1'}}});
 const h=webhook({chargeOverrides:{amount_refunded:0}});assert.equal((await h.send(e)).status,200);assert.equal(h.calls[0].args.snapshot.refunded_amount_jpy,0);assert.equal(h.calls[0].args.snapshot.stripe_checkout_session_id,undefined);
 const bad=webhook({rpcError:true});assert.equal((await bad.send(event())).status,503);assert.equal(bad.calls.length,1);
});

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function ui(rpc){
 const ids=['adminPaymentSummary','adminRecentPayments','adminPaymentMore','adminRefundList','adminRefundMore'];
 const nodes=new Map(ids.map(id=>[id,{innerHTML:'',textContent:'',classList:{add(){},toggle(){}},appendChild(n){this.innerHTML+=n.textContent;}}]));
 const c={sb:{rpc},currentUser:{id:'operator'},isVoiceFleaAdmin:()=>c.currentUser?.id==='operator',document:{getElementById:id=>nodes.get(id),createElement:()=>({})},Map,Date,Number,String,Error,adminSetStat(){},financeYen:n=>`${n}円`,formatJpDateTime:x=>x,esc:s=>String(s).replaceAll('<','&lt;')};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const adminPaymentViews='),html.indexOf('let adminBoostRows='))+'\nthis.state=adminPaymentViews;',c);return{c,nodes};
}
test('operator payment paging keeps loaded records on failure, includes partial refunds, and discards stale private results',async()=>{
 let count=0;const cursors=[];const row={id:'1',listing_title:'<Voice>',status:'partially_refunded',amount_jpy:1000,refunded_amount_jpy:300,stripe_reconciled_at:'2026',environment:'Test',created_at:'2026'};
 const {c,nodes}=ui(async(name,cursor)=>{cursors.push(cursor);count++;return count===2?{error:true}:{data:{rows:[{...row,id:count===1?'1':'2'}],summary:[],has_more:count===1}};});
 await c.loadAdminPaymentReceipts();await c.loadAdminPaymentReceipts(true);assert.equal(c.state.dashboard.rows.length,1);
 await c.loadAdminPaymentReceipts(true);assert.equal(c.state.dashboard.rows.length,2);assert.deepEqual(cursors[1],cursors[2]);assert.match(nodes.get('adminRecentPayments').innerHTML,/一部/);assert.match(nodes.get('adminRecentPayments').innerHTML,/300円/);assert.match(nodes.get('adminRecentPayments').innerHTML,/&lt;Voice>/);
 let resolve;const other=ui(()=>new Promise(r=>resolve=r));const pending=other.c.loadAdminPaymentReceipts();other.c.currentUser={id:'ordinary'};resolve({data:{rows:[row],summary:[],has_more:false}});await pending;assert.equal(other.c.state.dashboard.rows.length,0);
});
function manualCompletion(){const e=event();e.data.object.payment_status='unpaid';e.data.object.metadata.capture_flow='receipt-v1';return e;}
function manualOptions(overrides={}){const e=manualCompletion();return {piOverrides:{status:'requires_capture',capture_method:'manual',amount_capturable:1000,application_fee_amount:150,transfer_data:{destination:'acct_seller'},metadata:e.data.object.metadata,...overrides},chargeOverrides:{captured:false,amount_captured:0,amount_refunded:0,payment_method_details:{card:{capture_before:2000000000}}}};}
test('signed manual Checkout stores an authorization without recording captured money, and binds the quote and metadata',async()=>{
 const h=webhook(manualOptions());assert.equal((await h.send(manualCompletion())).status,200);assert.deepEqual(h.calls.map(x=>x.name),['record_stripe_authorization','finish_checkout_reservation']);
 const s=h.calls[0].args.snapshot;assert.equal(s.amount_jpy,1000);assert.equal(s.stripe_destination,'acct_seller');assert.equal(s.reservation_id,'reservation');assert.equal(s.canceled,false);assert.equal(s.authorization_expires_at,new Date(2000000000000).toISOString());
 for(const changed of [{metadata:{capture_flow:'receipt-v1'}},{application_fee_amount:1},{capture_method:'automatic'},{amount_capturable:900}]){
  const bad=webhook(manualOptions(changed));assert.equal((await bad.send(manualCompletion())).status,503);assert.equal(bad.calls.length,0);
 }
});
test('canceled manual authorizations are not recorded as paid, and cancellation events reconcile the current provider state',async()=>{
 const h=webhook(manualOptions({status:'canceled'}));assert.equal((await h.send(manualCompletion())).status,200);assert.equal(h.calls[0].args.snapshot.canceled,true);assert.equal(h.calls.some(x=>x.name==='record_stripe_payment_snapshot'),false);
 const cancel=event({type:'payment_intent.canceled',data:{object:{id:'pi_test1',metadata:{capture_flow:'receipt-v1'}}}});
 const current=webhook(manualOptions({status:'canceled'}));assert.equal((await current.send(cancel)).status,200);assert.equal(current.calls[0].name,'record_voice_authorization_canceled');
 const late=webhook(manualOptions({status:'succeeded'}));assert.equal((await late.send(cancel)).status,200);assert.equal(late.calls.length,0);
});
