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
 await db.exec('reset role');await db.exec(read('20261102140552_apple_refund_review_holds.sql'));await db.exec("create table voice_flea_private.moderators(user_id uuid primary key);insert into voice_flea_private.moderators values('${buyer}');".replace('${buyer}',buyer));await db.exec('create table voice_flea_private.account_deletions(user_id uuid primary key,completed_at timestamptz)');await db.exec(read('20261102142155_apple_financial_resolution_audit.sql'));return {db,purchase,prepare,order};
}
const claim=(db,id)=>db.query('select public.claim_apple_settlement($1) r',[id]);
const record=(db,id,e)=>db.query('select public.record_apple_settlement($1,$2) r',[id,e]);
const evidence=o=>({id:'tr_apple',object:'transfer',livemode:true,amount:541,currency:'jpy',destination:'acct_seller',source_transaction:null,amount_reversed:0,reversed:false,transfer_group:'apple_settlement_'+o.id,metadata:{apple_settlement_id:o.id,payment_id:o.payment_id}});


const operation='00000000-0000-4000-8000-000000000071';
async function bankSetup(fee=0){const x=await setup();const {db,prepare,purchase}=x;
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);const op=await prepare();await db.exec('reset role;set role service_role');await claim(db,op.id);await record(db,op.id,evidence(op));
 const summary={kind:'bank',paymentId:purchase.paymentId,transferId:op.transfer_id||'tr_apple',destination:op.destination,payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'statement-ref',receivedDate:'2026-11-01',payoutAmountJpy:541,receivedAmountJpy:541,sellerAmountJpy:541,creditFeeJpy:fee,creditNetJpy:541-fee,batchAllPositiveNoFees:fee===0,batchMatchesPayout:true,batchNetTotalJpy:541,eligibleForSettlement:fee===0};
 const input={paymentId:purchase.paymentId};return {...x,op,summary,input};}
const observation=s=>s.kind!=='bank'?null:{transfer:{data:{id:s.transferId,metadata:{payment_id:s.paymentId}}},payout:{data:{id:s.payoutId},context:{accountId:s.destination,source:'stripe_server_api'}}};
const store=(db,id,p,input,summary)=>db.query('select public.store_apple_financial_review($1,$2,$3,$4,$5,$6,$7) r',[buyer,id,summary.kind,p,input,summary,observation(summary)]).then(x=>x.rows[0].r);
const approve=(db,r,summary=r.summary)=>db.query('select public.approve_apple_financial_review($1,$2,$3,$4,$5) r',[buyer,r.id,r.preview_hash,summary,observation(summary)]).then(x=>x.rows[0].r);
test('operator bank reconciliation completes a normal sale once; payout failure reopens exact obligations',async()=>{
 const {db,purchase,summary,input}=await bankSetup();try{
  const r=await store(db,operation,purchase.paymentId,input,summary);assert.equal(r.state,'preview');await approve(db,r);await approve(db,r);
  await db.exec('reset role');assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'settled');
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[seller])).rows[0].pending,false);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_resolution_events')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_resolution_observations')).rows[0].n,2);
  assert.equal((await db.query("select bool_and(sha256=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')) ok from voice_flea_private.apple_resolution_observations")).rows[0].ok,true);
  await db.exec('set role service_role');await db.query("select public.invalidate_apple_bank_payout('acct_wrong','po_test','evt_wrong')");await db.exec('reset role');assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'settled');
  await db.exec('set role service_role');await db.query("select public.invalidate_apple_bank_payout('acct_seller','po_test','evt_failed')");await db.exec('reset role');
  assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'needs_review');assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[seller])).rows[0].pending,true);
 }finally{await db.close();}
});
test('unknown credit fee never releases settlement, and changed previews or unauthorized callers cannot approve',async()=>{
 const {db,purchase,summary,input}=await bankSetup(1);try{
  const r=await store(db,operation,purchase.paymentId,input,summary);await assert.rejects(approve(db,r,{...summary,creditFeeJpy:0}),/Preview changed/);
  await db.exec('reset role;set role authenticated');await assert.rejects(approve(db,r),/permission denied/);
  await db.exec('reset role;set role service_role');await approve(db,r);await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_terminal_settlements')).rows[0].n,0);
  assert.equal((await db.query('select voice_flea_private.apple_settlement_pending_for_user($1) pending',[seller])).rows[0].pending,true);
 }finally{await db.close();}
});
test('actual report return facts are approved once but do not invent a split or release a hold',async()=>{
 const {db,purchase}=await setup();try{
  await db.query('update voice_flea_private.apple_financial_reports set snapshot=$1 where id=$2',[{rows:[{line:2,kind:'R',quantity:-1,currency:'JPY',customerCurrency:'JPY',country:'JP',sku:'com.ayuhide.koenofurima.voice.jpy1000',customerPrice:'-500.00',unitProceeds:'318.18',proceeds:'-318.18'}]},report]);
  const summary={kind:'adjustment',paymentId:purchase.paymentId,customerRefundJpy:500,appleNetDebit:'318.18'},input={reportId:report,lineNumber:2};await db.exec('set role service_role');
  const r=await store(db,operation,purchase.paymentId,input,summary);await approve(db,r);await approve(db,r);
  const second=await store(db,'00000000-0000-4000-8000-000000000072',purchase.paymentId,input,summary);await assert.rejects(approve(db,second),/duplicate key/);
  await db.exec('reset role');const p=(await db.query('select * from payments where id=$1',[purchase.paymentId])).rows[0];assert.equal(p.refunded_amount_jpy,0);assert.equal((await db.query('select state from voice_flea_private.apple_financial_adjustments')).rows[0].state,'policy_review_required');
  assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) ok from payments p where id=$1',[purchase.paymentId])).rows[0].ok,false);
 }finally{await db.close();}
});
test('late Apple refunds reopen a previously bank-reconciled sale without losing its evidence',async()=>{
 const {db,purchase,summary,input,order}=await bankSetup();try{const r=await store(db,operation,purchase.paymentId,input,summary);await approve(db,r);await db.exec('reset role');
  await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',true,$2)",[order.orderId,buyer]);
  assert.equal((await db.query('select state from voice_flea_private.apple_terminal_settlements')).rows[0].state,'needs_review');assert.equal((await db.query('select state from voice_flea_private.apple_bank_receipts')).rows[0].state,'operator_approved');
  assert.equal((await db.query('select state from voice_flea_private.apple_proceeds_allocations')).rows[0].state,'adjustment_required');
 }finally{await db.close();}
});

test('late refund after deletion preparation rolls back completion and earlier anonymization in the same transaction',async()=>{
 const {db,purchase,summary,input,order}=await bankSetup();try{const r=await store(db,operation,purchase.paymentId,input,summary);await approve(db,r);await db.exec('reset role');
  await db.query('insert into voice_flea_private.account_deletions(user_id) values($1)',[seller]);
  await db.query("select public.apply_verified_apple_voice($1,'123','com.ayuhide.koenofurima.voice.jpy1000','Production',now(),1000000,'JPY',true,$2)",[order.orderId,buyer]);
  await db.exec('begin');await db.query("update profiles set stripe_account_id='anonymized' where id=$1",[seller]);
  await assert.rejects(db.query('update voice_flea_private.account_deletions set completed_at=now() where user_id=$1',[seller]),/financial review required/);await db.exec('rollback');
  assert.equal((await db.query('select stripe_account_id from profiles where id=$1',[seller])).rows[0].stripe_account_id,'acct_seller');
  assert.equal((await db.query('select completed_at from voice_flea_private.account_deletions where user_id=$1',[seller])).rows[0].completed_at,null);
 }finally{await db.close();}
});

test('bank approval cannot omit or swap the server observation, and private audit is not client-readable',async()=>{
 const {db,purchase,summary,input}=await bankSetup();try{
  await assert.rejects(db.query('select public.store_apple_financial_review($1,$2,$3,$4,$5,$6)',[buyer,operation,'bank',purchase.paymentId,input,summary]),/Server observation required/);
  const r=await store(db,operation,purchase.paymentId,input,summary);
  await assert.rejects(db.query('select public.approve_apple_financial_review($1,$2,$3,$4,$5)',[buyer,r.id,r.preview_hash,r.summary,{...observation(summary),payout:{data:{id:'po_other'},context:{accountId:'acct_seller',source:'stripe_server_api'}}}]),/Server observation required/);
  await db.exec('reset role;set role authenticated');await assert.rejects(db.query('select * from voice_flea_private.apple_resolution_observations'),/permission denied/);
 }finally{await db.close();}
});

test('mixed payout batches or a bank payout smaller than the seller credit cannot discharge the seller liability',async()=>{
 for(const fields of [{batchAllPositiveNoFees:false},{batchMatchesPayout:false},{batchNetTotalJpy:540},{payoutAmountJpy:500,receivedAmountJpy:500,batchNetTotalJpy:500}]){
  const {db,purchase,summary,input}=await bankSetup();try{Object.assign(summary,fields);const r=await store(db,operation,purchase.paymentId,input,summary);await approve(db,r);await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_terminal_settlements')).rows[0].n,0);}finally{await db.close();}
 }
});

test('a payout failure arriving before any bank receipt is durably remembered and defeats stale approval',async()=>{
 const {db,purchase,summary,input}=await bankSetup();try{
  await db.query("select public.invalidate_apple_bank_payout('acct_seller','po_test','evt_early')");await db.query("select public.invalidate_apple_bank_payout('acct_seller','po_test','evt_early')");
  const r=await store(db,operation,purchase.paymentId,input,summary);assert.equal((await approve(db,r)).state,'invalidated');await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_failed_payouts')).rows[0].n,1);assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_terminal_settlements')).rows[0].n,0);
 }finally{await db.close();}
});
