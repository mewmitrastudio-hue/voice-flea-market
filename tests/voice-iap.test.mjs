import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const listing='00000000-0000-4000-8000-000000000004',attempt='00000000-0000-4000-8000-000000000005';
const sku='com.ayuhide.koenofurima.voice.jpy1000';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
async function database(){
 const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create schema voice_flea_private;grant usage on schema auth,voice_flea_private to authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);insert into auth.users values('${buyer}'),('${seller}'),('${other}');
 create table disabled_accounts(id uuid);
 create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null and not exists(select 1 from public.disabled_accounts where id=actor)$$;
 create table listings(id uuid primary key,seller_id uuid,price_jpy integer,is_active boolean);
 insert into listings values('${listing}','${seller}',1000,true);
 create table user_blocks(blocker_id uuid,blocked_user_id uuid);
 create table jobs(id uuid,buyer_id uuid);create table applications(job_id uuid,applicant_id uuid,status text);
 create table payments(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,
 amount_jpy integer not null,platform_fee_jpy integer not null default 0,seller_amount_jpy integer not null default 0,
 status text,stripe_checkout_session_id text,stripe_payment_intent_id text,stripe_charge_id text,
 stripe_reconciled_at timestamptz,stripe_livemode boolean,refunded_amount_jpy integer,refunded_at timestamptz,
 paid_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
 create table conversations(id uuid primary key default gen_random_uuid(),listing_id uuid,buyer_id uuid,seller_id uuid,
 job_id uuid,is_inquiry boolean default false,delivery_status text default 'none',delivery_path text,
 delivered_at timestamptz,accepted_at timestamptz,created_at timestamptz default now());
 alter table conversations enable row level security;grant select,insert,update on conversations to authenticated;
 create policy own on conversations to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid()) with check(buyer_id=auth.uid() or seller_id=auth.uid());
 alter table payments enable row level security;grant select on payments to authenticated;
 create policy own on payments for select to authenticated using(buyer_id=auth.uid() or seller_id=auth.uid());
 `);
 await db.exec(read('supabase/migrations/20261024095131_exact_purchase_conversation_and_fee_policy.sql'));
 await db.exec(read('supabase/migrations/20261024100350_freeze_refunded_trade_fulfillment.sql'));
 await db.exec(read('tests/fixtures/trade-authority.sql'));
 await db.exec(read('supabase/migrations/20261028010000_voice_iap.sql'));
 return db;
}
const prepare=(db,id=attempt,owner=buyer,env='Sandbox')=>db.query('select public.prepare_voice_iap_order($1,$2,$3,$4) r',[owner,listing,id,env]).then(r=>r.rows[0].r);
const apply=(db,opts={})=>db.query('select public.apply_verified_apple_voice($1,$2,$3,$4,$5,$6,$7,$8,$9) r',[
 opts.order||attempt,opts.tx||'123456789',opts.sku||sku,opts.environment||'Sandbox',opts.date||new Date().toISOString(),
 'price' in opts?opts.price:1000000,'currency' in opts?opts.currency:'JPY',opts.revoked??false,opts.actor??buyer
]).then(r=>r.rows[0].r);

test('Apple voice catalogue fails closed and intents bind buyer, listing, price and environment',async()=>{
 const db=await database();try{
  await assert.rejects(prepare(db),/Apple product not ready/);
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');
  const first=await prepare(db);assert.equal(first.amountJpy,1000);assert.equal(first.productId,sku);
  const retry=await prepare(db,'00000000-0000-4000-8000-000000000006');assert.equal(retry.orderId,first.orderId);
  await assert.rejects(prepare(db,attempt,other),/Order mismatch/);
  await assert.rejects(prepare(db,attempt,buyer,'Production'),/Order mismatch/);
  await assert.rejects(prepare(db,'00000000-0000-4000-8000-000000000007',buyer,'Production'),/Apple product not ready/);
  await db.exec('set role authenticated');
  await assert.rejects(prepare(db),/permission denied/);await assert.rejects(apply(db),/permission denied/);
  await assert.rejects(db.query('select * from voice_flea_private.voice_iap_orders'),/permission denied/);
  await db.exec('reset role;update listings set price_jpy=1500');
  await assert.rejects(prepare(db),/Apple product not ready/,'an old intent cannot bypass current product configuration');
  await assert.rejects(prepare(db,'00000000-0000-4000-8000-000000000008'),/Apple product not ready/);
 }finally{await db.close();}
});

test('verified voice purchase creates exactly one payment/trade, survives retry, and never invents Apple proceeds',async()=>{
 const db=await database();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');await prepare(db);
  const r=await apply(db);const repeat=await apply(db);assert.equal(r.paymentId,repeat.paymentId);assert.equal(r.conversationId,repeat.conversationId);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  const p=(await db.query('select * from payments')).rows[0];assert.equal(p.status,'paid');assert.equal(p.payment_channel,'ios');
  for(const field of ['platform_fee_jpy','seller_amount_jpy','stripe_livemode','stripe_reconciled_at','stripe_payment_intent_id'])assert.equal(p[field],null,field);
  assert.equal(p.apple_environment,'Sandbox');
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
  const opened=(await db.query('select public.open_paid_purchase_conversation($1) r',[r.paymentId])).rows[0].r;assert.equal(opened.id,r.conversationId);
  await assert.rejects(db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[r.conversationId]),/not allowed/);
  await db.exec(`set request.jwt.claim.sub='${seller}'`);
  await db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[r.conversationId]);
  await assert.rejects(db.query("update conversations set delivery_status='accepted' where id=$1",[r.conversationId]),/not allowed/);
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);await db.query("update conversations set delivery_status='accepted' where id=$1",[r.conversationId]);
  assert.ok((await db.query('select accepted_at from conversations')).rows[0].accepted_at);
 }finally{await db.close();}
});

test('Apple receipt mismatch, replay to another order/account and refund rollback cannot unlock a trade',async()=>{
 const db=await database();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');await prepare(db);
  for(const options of [{actor:other},{price:999000},{price:null},{currency:'USD'},{environment:'Production'},{sku:sku+'0'},{date:'2000-01-01T00:00:00Z'}])await assert.rejects(apply(db,options),/Transaction mismatch/);
  assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,0);
  const r=await apply(db);
  const otherOrder='00000000-0000-4000-8000-000000000009';await prepare(db,otherOrder);
  await assert.rejects(apply(db,{order:otherOrder}),/unique constraint/);
  await assert.rejects(apply(db,{tx:'99999'}),/Order already consumed/);
  await apply(db,{revoked:true});await apply(db);assert.equal((await db.query('select status from payments where id=$1',[r.paymentId])).rows[0].status,'refunded');
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[r.conversationId]),/Paid purchase required/);
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);
  assert.equal((await db.query('select public.open_paid_purchase_conversation($1) r',[r.paymentId])).rows[0].r.id,r.conversationId,'refund retains existing history');
 }finally{await db.close();}
});

test('new orders reject self-purchases, blocked and deleted accounts; pending paid orders remain recoverable after delisting',async()=>{
 const db=await database();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');
  await assert.rejects(prepare(db,attempt,seller),/Listing unavailable/);
  await db.exec(`insert into user_blocks values('${buyer}','${seller}')`);await assert.rejects(prepare(db),/Listing unavailable/);
  await db.exec(`delete from user_blocks;insert into disabled_accounts values('${seller}')`);await assert.rejects(prepare(db),/Listing unavailable/);
  await db.exec('delete from disabled_accounts');await prepare(db);await db.exec('update listings set is_active=false');
  await assert.rejects(prepare(db),/Listing unavailable/,'delisting prevents a fresh StoreKit purchase even with an old intent');
  const r=await apply(db);assert.ok(r.paymentId);assert.ok(r.conversationId);
 }finally{await db.close();}
});

function uiFixture({verifyFailure=false,accountSwitch=false}={}){
 const events=[],elements=new Map(),storage=new Map();let resolvePurchase;
 const plugin={pendingTransactions:async options=>{assert.equal(options.kind,'voice');return {transactions:[]};},products:async()=>({environment:'Sandbox',products:[{id:sku,displayPrice:'¥1,000',currencyCode:'JPY',price:'1000'}]}),purchase:async()=>{events.push('purchase');return await new Promise(r=>resolvePurchase=r);},finish:async()=>events.push('finish')};
 const c={currentUser:{id:buyer},isNativeBoost:()=>true,nativeBoost:async()=>({plugin}),safeLocalStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},crypto:{randomUUID:()=>attempt},document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{classList:{add(){},remove(){}},hidden:false,textContent:''});return elements.get(id);}},alert(){},go(){events.push('go')},openConversation:async()=>events.push('open'),sb:{functions:{invoke:async(_,args)=>{
  if(args.body.action==='prepare')return {data:{orderId:attempt,productId:sku,amountJpy:1000,environment:'Sandbox',state:'prepared'}};
  events.push('verify');if(accountSwitch)c.currentUser={id:other};
  return verifyFailure?{error:{}}:{data:{success:true,paymentId:'payment',conversationId:'conversation'}};
 }}}};
 vm.createContext(c);const html=read('index.html');vm.runInContext(html.slice(html.indexOf('let voicePurchaseBusy='),html.indexOf('</script>',html.indexOf('let voicePurchaseBusy='))),c);
 return {c,events,elements,complete:result=>resolvePurchase(result)};
}
test('voice purchase locks repeated taps and finishes only after durable server verification',async()=>{
 const f=uiFixture();await f.c.startVoicePurchase(listing);const first=f.c.confirmVoicePurchase();await f.c.confirmVoicePurchase();assert.equal(f.events.filter(x=>x==='purchase').length,1);
 f.complete({status:'purchased',signedTransaction:'signed',transactionId:'123'});await first;assert.deepEqual(f.events,['purchase','verify','finish','go','open']);
 const failed=uiFixture({verifyFailure:true});await failed.c.startVoicePurchase(listing);const p=failed.c.confirmVoicePurchase();failed.complete({status:'purchased',signedTransaction:'signed',transactionId:'123'});await p;assert.ok(!failed.events.includes('finish'));assert.match(failed.elements.get('voicePurchaseStatus').textContent,/再購入せず/);
 const cancelled=uiFixture();await cancelled.c.startVoicePurchase(listing);const q=cancelled.c.confirmVoicePurchase();cancelled.complete({status:'cancelled'});await q;assert.deepEqual(cancelled.events,['purchase']);
 const switched=uiFixture({accountSwitch:true});await switched.c.startVoicePurchase(listing);const t=switched.c.confirmVoicePurchase();switched.complete({status:'purchased',signedTransaction:'signed',transactionId:'123'});await t;assert.ok(!switched.events.includes('open'));
});
