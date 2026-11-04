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
 await db.exec(read('20261102055040_apple_refund_recovery_journal.sql'));
 await db.exec('update voice_flea_private.voice_iap_products set production_enabled=true');
 const order=(await db.query('select public.prepare_voice_iap_order($1,$2,$3,$4) r',[buyer,listing,'00000000-0000-4000-8000-000000000009','Production'])).rows[0].r;
 const purchase=(await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',false,$2) r",[order.orderId,buyer])).rows[0].r;
 await db.query("update conversations set delivery_status='accepted',delivery_path=id::text||'/voice.m4a',accepted_at=now() where id=$1",[purchase.conversationId]);
 await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[report,{rows:[{line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku:'com.ayuhide.koenofurima.voice.jpy1000',quantity:1,unitProceeds:'636.36',proceeds:'636.36',customerPrice:'1000'}]}]);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
 await db.query('select public.allocate_apple_proceeds($1,2,$2,$3)',[report,[purchase.paymentId],'Verified report matches the completed purchase.']);
 const prepare=()=>db.query("select public.prepare_apple_settlement($1,'acct_platform') r",[purchase.paymentId]).then(r=>r.rows[0].r);
 await db.exec('reset role');await db.exec(read('20261102140552_apple_refund_review_holds.sql'));return {db,purchase,prepare,order};
}
const claim=(db,id)=>db.query('select public.claim_apple_settlement($1) r',[id]);
const record=(db,id,e)=>db.query('select public.record_apple_settlement($1,$2) r',[id,e]);
const evidence=o=>({id:'tr_apple',object:'transfer',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,amount_reversed:0,reversed:false,transfer_group:'apple_settlement_'+o.id,metadata:{apple_settlement_id:o.id,payment_id:o.payment_id}});

const hold=(db,order,actor=buyer,tx='123')=>db.query('select public.record_apple_refund_review($1,$2,$3,$4,$5,$6,$7,$8) r',[order.orderId,tx,'Production','com.ayuhide.koenofurima.voice.jpy1000',1000000,'JPY',{refundEvidenceVersion:1,revocationDate:1780000000000,revocationType:'REFUND_PRORATED',revocationPercentage:50000},actor]);
test('durable refund review blocks fulfillment, allocation/dispatch and related-account deletion without inventing a refund',async()=>{
 const {db,purchase,prepare,order}=await setup();try{
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);const op=await prepare();
  await assert.rejects(hold(db,order),/permission denied/);
  await db.exec('reset role;set role service_role');await hold(db,order);await hold(db,order);
  await assert.rejects(claim(db,op.id),/refund review/);
  await assert.rejects(db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,purchase.conversationId]),/Verified payment required/);
  await assert.rejects(db.query('select public.finalize_delivery_acceptance($1,$2)',[buyer,purchase.conversationId]),/Verified captured payment required/);
  await db.exec('reset role');
  const p=(await db.query('select * from payments where id=$1',[purchase.paymentId])).rows[0];assert.equal(p.status,'paid');assert.equal(p.refunded_amount_jpy,0);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_refund_review_holds')).rows[0].n,1);
  assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) ok from payments p where id=$1',[purchase.paymentId])).rows[0].ok,false);
  for(const id of [buyer,seller])assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) ok',[id])).rows[0].ok,true);
  assert.equal((await db.query("select voice_flea_private.apple_settlement_pending_for_user('00000000-0000-4000-8000-000000000003') ok")).rows[0].ok,false);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(db.query("update conversations set delivery_status='submitted' where id=$1",[purchase.conversationId]),/Verified payment required|Paid purchase required/);
  assert.equal((await db.query('select public.apple_refund_review_status() r')).rows[0].r.count,1);
  await db.exec("set request.jwt.claim.sub='00000000-0000-4000-8000-000000000003'");assert.equal((await db.query('select public.apple_refund_review_status() r')).rows[0].r.count,0);
  await assert.rejects(db.query('select * from voice_flea_private.apple_refund_review_holds'),/permission denied/);
 }finally{await db.close();}
});
test('a hold rejects mismatched actor and identity and survives subsequent full-refund observation',async()=>{
 const {db,order,purchase}=await setup();try{
  await db.exec('set role service_role');await assert.rejects(hold(db,order,seller),/evidence mismatch/);await assert.rejects(hold(db,order,buyer,'999'),/evidence mismatch/);
  await hold(db,order);await db.exec('reset role');
  await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',true,$2)",[order.orderId,buyer]);
  assert.equal((await db.query('select voice_flea_private.verified_voice_refund(p) ok from payments p where id=$1',[purchase.paymentId])).rows[0].ok,false);
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) ok',[buyer])).rows[0].ok,true);
 }finally{await db.close();}
});

test('a hold arriving before payment blocks later fulfillment and is scoped to that order',async()=>{
 const {db}=await setup();try{
  const other='00000000-0000-4000-8000-000000000003';
  const order=(await db.query("select public.prepare_voice_iap_order($1,$2,'00000000-0000-4000-8000-000000000099','Production') r",[other,listing])).rows[0].r;
  await db.exec('set role service_role');await hold(db,order,other,'456');await db.exec('reset role');
  await assert.rejects(db.query("select public.apply_verified_apple_voice($1,'456','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',false,$2)",[order.orderId,other]),/Verified paid purchase required/);
  assert.equal((await db.query('select payment_id from voice_flea_private.voice_iap_orders where id=$1',[order.orderId])).rows[0].payment_id,null);
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) ok',[other])).rows[0].ok,true);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_refund_review_holds')).rows[0].n,1);
 }finally{await db.close();}
});

test('refund hold prevents full seller recovery and repeat allocation while preserving in-flight transfer evidence',async()=>{
 const {db,order,purchase,prepare}=await setup();try{
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);const op=await prepare();
  await db.exec('reset role;set role service_role');await claim(db,op.id);await hold(db,order);await record(db,op.id,evidence(op));
  await db.exec('reset role');await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',true,$2)",[order.orderId,buyer]);
  await db.exec('set role service_role');await assert.rejects(db.query('select public.claim_apple_recovery($1)',[op.id]),/Verified full refund/);
  await db.exec('reset role');
  const allocation=(await db.query('select * from voice_flea_private.apple_proceeds_allocations where payment_id=$1',[purchase.paymentId])).rows[0];
  await assert.rejects(db.query('insert into voice_flea_private.apple_proceeds_allocations select * from jsonb_populate_record(null::voice_flea_private.apple_proceeds_allocations,$1)',[allocation]),/refund review/);
  assert.equal((await db.query('select state from voice_flea_private.apple_settlement_operations where id=$1',[op.id])).rows[0].state,'transferred');
 }finally{await db.close();}
});
