import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {receiptDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',listing='00000000-0000-4000-8000-000000000004';
const migration=fs.readFileSync(new URL('../supabase/migrations/20261028230304_pending_trade_summary.sql',import.meta.url),'utf8');
async function add(db,{owner=buyer,provider=seller,status='paid',delivery='none',manual=false,expired=false}={}){
 const p=(await db.query(`insert into payments(listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,stripe_reconciled_at,stripe_livemode,refunded_amount_jpy,stripe_capture_method,authorization_expires_at) values($1,$2,$3,1000,150,850,'paid',now(),false,0,$4,now()+interval '1 day') returning id`,[listing,owner,provider,manual?'manual':'automatic'])).rows[0].id;
 const c=(await db.query('insert into conversations(listing_id,buyer_id,seller_id,payment_id,delivery_status,delivery_path) values($1,$2,$3,$4,$5,$6) returning id',[listing,owner,provider,p,delivery,delivery==='none'?null:'voice.m4a'])).rows[0].id;
 await db.query("update payments set status=$1,authorization_expires_at=case when $2 then now()-interval '1 day' else authorization_expires_at end,refunded_amount_jpy=case when $1='refunded' then 1000 else 0 end where id=$3",[status,expired,p]);return c;
}
const summary=(db,cursor)=>db.query('select public.pending_trade_summary($1,$2) r',[cursor?.created_at||null,cursor?.conversation_id||null]).then(r=>r.rows[0].r);
test('pending notices count all own unfinished trades, distinguish required actions, paginate tied dates and exclude completed/refunded/foreign trades',async()=>{
 const db=await receiptDatabase();try{
  await db.exec(migration);
  const own=[];for(let i=0;i<25;i++)own.push(await add(db,{delivery:i%2?'submitted':'none'}));
  await add(db,{delivery:'accepted'});await add(db,{status:'refunded'});await add(db,{owner:other});
  const expired=await add(db,{status:'authorized',manual:true,expired:true});own.push(expired);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
  const first=await summary(db);assert.equal(first.total,26);assert.equal(first.needsAction,13);assert.equal(first.waiting,13);assert.equal(first.rows.length,10);assert.equal(first.hasMore,true);
  const rows=[...first.rows];let page=first;while(page.hasMore){page=await summary(db,page.rows.at(-1));assert.equal(page.total,26);rows.push(...page.rows);}
  assert.equal(new Set(rows.map(x=>x.conversation_id)).size,26);assert.ok(rows.every(x=>own.includes(x.conversation_id)));
  assert.equal(rows.find(x=>x.conversation_id===expired).action,'reauthorization');assert.ok(rows.every(x=>x.is_test===true));
  await assert.rejects(db.query('select public.pending_trade_summary(now(),null)'),/Incomplete cursor/);
  await db.exec(`set request.jwt.claim.sub='${other}'`);assert.equal((await summary(db)).total,1);
  await db.exec('set role anon');await assert.rejects(summary(db),/permission denied/);
 }finally{await db.close();}
});
test('buyer completion clears their notice while Production Apple seller proceeds remain visibly pending',async()=>{
 const db=await receiptDatabase();try{
  await db.exec(migration);await db.exec('update voice_flea_private.voice_iap_products set production_enabled=true');
  const order=(await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4) r',[buyer,listing,'00000000-0000-4000-8000-000000000009','Production'])).rows[0].r;
  const purchase=(await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',false,$2) r",[order.orderId,buyer])).rows[0].r;
  await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[purchase.conversationId]);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);assert.equal((await summary(db)).total,0);
  await db.exec(`set request.jwt.claim.sub='${seller}'`);const pending=await summary(db);assert.equal(pending.total,1);assert.equal(pending.rows[0].action,'settlement_wait');assert.equal(pending.needsAction,0);assert.equal(pending.waiting,1);
 }finally{await db.close();}
});
