import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',listing='00000000-0000-4000-8000-000000000004';
function snapshot(overrides={}){return {buyer_id:buyer,seller_id:seller,listing_id:listing,amount_jpy:1000,stripe_payment_intent_id:'pi_receipt',stripe_charge_id:'ch_receipt',stripe_checkout_session_id:'cs_test_receipt',stripe_livemode:false,stripe_destination:'acct_seller',stripe_reconciled_at:new Date().toISOString(),authorization_expires_at:new Date(Date.now()+86400000).toISOString(),...overrides};}
async function authorize(db,s=snapshot()){
 const prior=(await db.query('select reservation_id from voice_flea_private.voice_checkout_intents limit 1')).rows[0];
 if(prior)s.reservation_id=prior.reservation_id;else{const q=(await db.query('select public.prepare_voice_checkout($1,$2,$3) q',[buyer,listing,'acct_seller'])).rows[0].q;s.reservation_id=q.reservation_id;await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',[s.stripe_checkout_session_id,q.reservation_id]);}
 await db.query('select public.record_stripe_authorization($1)',[s]);return (await db.query('select * from conversations')).rows[0];}
const prep=(db,c,actor=buyer)=>db.query('select public.prepare_delivery_acceptance($1,$2) r',[actor,c.id]).then(r=>r.rows[0].r);
const finish=(db,c,transfer='tr_receipt')=>db.query('select public.finalize_delivery_acceptance($1,$2,$3) r',[buyer,c.id,transfer]).then(r=>r.rows[0].r);
async function deliver(db,c){await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);await db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[c.id]);await db.exec("reset role;set request.jwt.claim.sub=''");}
test('authorization creates one unpaid trade, permits seller delivery, and never permits client receipt acceptance',async()=>{
 const db=await receiptDatabase();try{
  const c=await authorize(db);await authorize(db);assert.equal((await db.query('select count(*)::int n from payments')).rows[0].n,1);
  assert.equal((await db.query('select status,paid_at from payments')).rows[0].status,'authorized');
  await deliver(db,c);await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
  await assert.rejects(db.query("update conversations set delivery_status='accepted',accepted_at=now() where id=$1",[c.id]));
  await assert.rejects(prep(db,c),/permission denied/);await assert.rejects(finish(db,c),/permission denied/);
  await db.exec("reset role;set request.jwt.claim.sub=''");
  await assert.rejects(prep(db,c,other),/Delivered purchase required/);
  await prep(db,c);await assert.rejects(finish(db,c),/Verified captured payment required/);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(db.query("update conversations set delivery_path=id::text||'/replacement.m4a' where id=$1",[c.id]),/Server receipt/);
 }finally{await db.close();}
});
test('verified capture finalizes exactly one receipt, requires transfer evidence and never rewinds after old authorization',async()=>{
 const db=await receiptDatabase();try{
  const c=await authorize(db);await deliver(db,c);await prep(db,c);
  await db.exec("update payments set status='paid',paid_at=now(),stripe_reconciled_at=clock_timestamp()");
  await assert.rejects(finish(db,c,null),/Fresh capture/);
  const accepted=await finish(db,c);assert.equal(accepted.delivery_status,'accepted');
  assert.equal((await finish(db,c)).accepted_at,accepted.accepted_at);
  await authorize(db);assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
  assert.equal((await db.query('select count(*)::int n from conversations')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.delivery_acceptances')).rows[0].n,1);
 }finally{await db.close();}
});
test('expired authorization, identity changes, refunds and cancellation prevent delivery or receipt completion',async()=>{
 const db=await receiptDatabase();try{
  const s=snapshot(),c=await authorize(db,s);
  await assert.rejects(authorize(db,{...s,amount_jpy:1500}),/mismatch/);
  await db.exec("update payments set authorization_expires_at=now()-interval '1 second'");
  await assert.rejects(deliver(db,c),/authorization expired/);
  await db.exec("reset role;set request.jwt.claim.sub='';update payments set authorization_expires_at=now()+interval '1 day'");
  await deliver(db,c);await prep(db,c);
  await db.exec("update payments set status='paid',refunded_amount_jpy=100");await assert.rejects(finish(db,c),/Verified captured payment required/);
  await db.exec("update payments set refunded_amount_jpy=0;insert into voice_flea_private.trade_cancellations select id,'queued' from conversations");
  await assert.rejects(finish(db,c),/Cancellation in progress/);
 }finally{await db.close();}
});
test('server quotes are reused across tabs, keep their original amount and title, and deny blocked buyers and duplicate active orders',async()=>{
 const db=await receiptDatabase();try{
  const quote=async (actor=buyer)=>(await db.query('select public.prepare_voice_checkout($1,$2,$3) q',[actor,listing,'acct_seller'])).rows[0].q;
  const first=await quote();await db.exec("update listings set price_jpy=1500,title='Changed'");const again=await quote();
  assert.equal(again.reservation_id,first.reservation_id);assert.equal(again.amount_jpy,1000);assert.equal(again.title,'Voice');
  await db.exec(`insert into user_blocks values('${seller}','${other}')`);await assert.rejects(quote(other),/Listing unavailable/);
  await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',['cs_test_receipt',first.reservation_id]);
  await db.query('select public.record_stripe_authorization($1)',[snapshot({reservation_id:first.reservation_id})]);
  await assert.rejects(quote(),/Existing purchase or authorization/);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);await assert.rejects(quote(),/permission denied/);
 }finally{await db.close();}
});
test('undelivered authorization cancellation requires both owners, freezes delivery and records completion once',async()=>{
 const db=await receiptDatabase();try{
  const c=await authorize(db);
  const approve=async actor=>(await db.query('select public.prepare_authorization_cancellation($1,$2) r',[actor,c.id])).rows[0].r;
  await assert.rejects(approve(other),/Undelivered trade/);
  const first=await approve(buyer);assert.equal(first.ready,false);assert.equal(first.state,'requested');
  await assert.rejects(db.query('select public.finish_authorization_cancellation($1,$2)',[buyer,c.id]),/Agreed/);
  const second=await approve(seller);assert.equal(second.ready,true);assert.equal(second.state,'queued');
  await assert.rejects(deliver(db,c),/Server receipt/);await db.exec("reset role;set request.jwt.claim.sub=''");
  await db.query('select public.finish_authorization_cancellation($1,$2)',[buyer,c.id]);
  await db.query('select public.finish_authorization_cancellation($1,$2)',[seller,c.id]);
  assert.equal((await db.query('select status from payments')).rows[0].status,'canceled');
  assert.equal((await db.query('select count(*)::int n from messages')).rows[0].n,1);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${other}'`);
  await assert.rejects(db.query('select public.authorization_cancellation_status($1)',[c.id]),/Trade unavailable/);
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);
  const state=(await db.query('select public.authorization_cancellation_status($1) r',[c.id])).rows[0].r;assert.equal(state.state,'canceled');assert.equal(state.canApprove,false);
 }finally{await db.close();}
});
test('expired payment renewal preserves delivery and conversation, freezes the old quote and archives the canceled attempt',async()=>{
 const db=await receiptDatabase();try{
  const original=snapshot(),c=await authorize(db,original);await deliver(db,c);await prep(db,c);
  const oldPayment=(await db.query('select * from payments')).rows[0];
  await db.query('select public.finish_checkout_reservation($1,$2)',[original.reservation_id,original.stripe_checkout_session_id]);
  await db.exec("update payments set authorization_expires_at=now()-interval '1 second';update listings set price_jpy=2000,is_active=false,title='New listing'");
  await assert.rejects(db.query('select public.prepare_voice_renewal_checkout($1,$2)',[other,c.id]),/Renewal unavailable/);
  const q=(await db.query('select public.prepare_voice_renewal_checkout($1,$2) q',[buyer,c.id])).rows[0].q;
  assert.equal(q.amount_jpy,1000);assert.equal(q.title,'Voice');assert.equal(q.renewal_conversation_id,c.id);
  const retry=(await db.query('select public.prepare_voice_renewal_checkout($1,$2) q',[buyer,c.id])).rows[0].q;assert.equal(retry.reservation_id,q.reservation_id);
  const fresh=snapshot({reservation_id:q.reservation_id,stripe_payment_intent_id:'pi_renewed',stripe_checkout_session_id:'cs_test_renewed',stripe_charge_id:'ch_renewed'});
  await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',[fresh.stripe_checkout_session_id,q.reservation_id]);
  await db.query('select public.record_stripe_authorization($1)',[fresh]);
  const rows=(await db.query('select * from conversations')).rows;assert.equal(rows.length,1);assert.equal(rows[0].id,c.id);assert.equal(rows[0].delivery_status,'submitted');assert.equal(rows[0].delivery_path,c.id+'/voice.m4a');
  const newPayment=(await db.query("select * from payments where stripe_payment_intent_id='pi_renewed'")).rows[0];assert.equal(rows[0].payment_id,newPayment.id);
  assert.equal((await db.query('select status from payments where id=$1',[oldPayment.id])).rows[0].status,'canceled');
  assert.equal((await db.query('select payment_id from voice_flea_private.delivery_acceptances')).rows[0].payment_id,newPayment.id);
  await db.query('select public.record_stripe_authorization($1)',[original]);
  assert.equal((await db.query('select payment_id from conversations')).rows[0].payment_id,newPayment.id);
  await db.query("update payments set status='paid',stripe_reconciled_at=clock_timestamp() where id=$1",[newPayment.id]);
  assert.equal((await finish(db,c)).delivery_status,'accepted');
 }finally{await db.close();}
});
