import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {receiptDatabase} from './fixtures/receipt-database.mjs';
const read=p=>fs.readFileSync(new URL('../supabase/migrations/'+p,import.meta.url),'utf8');
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000004',report='00000000-0000-4000-8000-000000000088';
async function setup(){
 const db=await receiptDatabase();
 await db.exec(`create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${buyer}'::uuid$$;create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);`);
 await db.exec(read('20261029033154_apple_proceeds_allocation_ledger.sql'));
 await db.exec(read('20261102003116_keep_allocated_apple_proceeds_pending.sql'));
 await db.exec(read('20261102020226_guard_apple_refund_settlement_on_deletion.sql'));
 await db.exec(read('20261102040116_apple_settlement_dispatch_journal.sql'));
 await db.exec('update voice_flea_private.voice_iap_products set production_enabled=true');
 const order=(await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4) r',[buyer,listing,'00000000-0000-4000-8000-000000000009','Production'])).rows[0].r;
 const purchase=(await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',false,$2) r",[order.orderId,buyer])).rows[0].r;
 await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[purchase.conversationId]);
 await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[report,{rows:[{line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku:'com.ayuhide.koenofurima.voice.jpy1000',quantity:1,unitProceeds:'636.36',proceeds:'636.36',customerPrice:'1000'}]}]);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
 await db.query('select public.allocate_apple_proceeds($1,2,$2,$3)',[report,[purchase.paymentId],'Verified report matches the completed purchase.']);
 const prepare=()=>db.query("select public.prepare_apple_settlement($1,'acct_platform') r",[purchase.paymentId]).then(r=>r.rows[0].r);
 return {db,purchase,prepare};
}
const claim=(db,id)=>db.query('select public.claim_apple_settlement($1) r',[id]);
const record=(db,id,e)=>db.query('select public.record_apple_settlement($1,$2) r',[id,e]);
const evidence=o=>({id:'tr_apple',object:'transfer',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,amount_reversed:0,reversed:false,transfer_group:'apple_settlement_'+o.id,metadata:{apple_settlement_id:o.id,payment_id:o.payment_id}});
test('actual Apple schema reserves one immutable transfer and denies client dispatch/forged evidence',async()=>{
 const {db,prepare,purchase}=await setup();try{
  const op=await prepare();assert.equal(op.amount_jpy,541);assert.equal((await prepare()).id,op.id);
  await assert.rejects(claim(db,op.id),/permission denied/);
  await assert.rejects(record(db,op.id,evidence(op)),/permission denied/);
  await db.exec(`set request.jwt.claim.sub='${seller}'`);await assert.rejects(prepare(),/Operator required/);
  await db.exec('reset role;set role service_role');
  await claim(db,op.id);await assert.rejects(claim(db,op.id),/already claimed/);
  const e=evidence(op);await assert.rejects(record(db,op.id,{...e,amount:542}),/evidence mismatch/);
  await assert.rejects(record(db,op.id,{...e,livemode:false}),/evidence mismatch/);
  const result=(await record(db,op.id,e)).rows[0].r;assert.equal(result.state,'transferred');
  assert.equal((await record(db,op.id,e)).rows[0].r.transfer_id,'tr_apple');
  await assert.rejects(record(db,op.id,{...e,id:'tr_other'}),/evidence mismatch/);
  await db.exec('reset role');
  const p=(await db.query('select platform_fee_jpy,seller_amount_jpy from payments where id=$1',[purchase.paymentId])).rows[0];assert.deepEqual(p,{platform_fee_jpy:null,seller_amount_jpy:null});
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[seller])).rows[0].pending,true);
 }finally{await db.close();}
});
test('refund before dispatch or changed recipient freezes transfer without resetting its journal',async()=>{
 for(const kind of ['refund','recipient']){
  const {db,prepare,purchase}=await setup();try{
   const op=await prepare();await db.exec('reset role');
   if(kind==='refund')await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[purchase.paymentId]);
   else await db.exec("update profiles set stripe_account_id='acct_changed'");
   await db.exec('set role service_role');await assert.rejects(claim(db,op.id),/frozen or recipient changed/);
   await db.exec('reset role');assert.equal((await db.query('select state from voice_flea_private.apple_settlement_operations')).rows[0].state,'prepared');
  }finally{await db.close();}
 }
});
test('refund during dispatch preserves transfer evidence, reversal cannot erase adjustment or release deletion',async()=>{
 const {db,prepare,purchase}=await setup();try{
  const op=await prepare();await db.exec('reset role;set role service_role');await claim(db,op.id);
  await db.exec('reset role');await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[purchase.paymentId]);
  await db.exec('set role service_role');await record(db,op.id,evidence(op));
  const partial={...evidence(op),amount_reversed:100};assert.equal((await record(db,op.id,partial)).rows[0].r.state,'partially_reversed');
  await assert.rejects(record(db,op.id,evidence(op)),/Reversal evidence mismatch/);
  const full={...evidence(op),amount_reversed:541,reversed:true};assert.equal((await record(db,op.id,full)).rows[0].r.state,'reversed');
  await db.exec('reset role');assert.equal((await db.query('select state from voice_flea_private.apple_proceeds_allocations')).rows[0].state,'adjustment_required');
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[seller])).rows[0].pending,true);
 }finally{await db.close();}
});
