import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {receiptDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',listing='00000000-0000-4000-8000-000000000004';
const sql=fs.readFileSync(new URL('../supabase/migrations/20261109044858_stripe_dispute_review_ledger.sql',import.meta.url),'utf8');
const snapshot=(extra={})=>({platform_id:'acct_platform',livemode:true,event_id:'evt_one',event_type:'charge.dispute.created',event_created:1800000000,dispute_id:'dp_test',charge_id:'ch_test',payment_intent_id:'pi_test',currency:'jpy',status:'needs_response',amount_jpy:500,charge_amount_jpy:1000,refunded_amount_jpy:0,destination:'acct_seller',buyer_id:buyer,seller_id:seller,listing_id:listing,job_id:null,transfer_id:'tr_test',evidence_due_by:'2030-01-01',observed_at:'2026-01-01',...extra});
const record=(db,s)=>db.query('select public.record_stripe_dispute_observation($1)',[s]);
async function setup(){
 const db=await receiptDatabase();
 await db.exec(`create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${buyer}'::uuid$$;
 create function public.prepare_account_deletion(target uuid) returns jsonb language sql as $$select '{"allowed":true}'::jsonb$$;
 create function public.finish_account_deletion(target uuid) returns void language plpgsql as $$begin end$$;`);
 await db.exec(sql);
 const p=(await db.query(`insert into payments(listing_id,buyer_id,seller_id,amount_jpy,platform_fee_jpy,seller_amount_jpy,status,payment_channel,stripe_payment_intent_id,stripe_charge_id,stripe_livemode,stripe_reconciled_at,refunded_amount_jpy,stripe_destination) values($1,$2,$3,1000,150,850,'paid','web','pi_test','ch_test',true,now(),0,'acct_seller') returning id`,[listing,buyer,seller])).rows[0].id;
 return {db,p};
}
test('transactional ledger binds receipt, deduplicates, handles late/won/lost/out-of-order without inventing recovery',async()=>{
 const {db,p}=await setup();try{
 await db.exec('set role service_role');await record(db,snapshot());await record(db,snapshot());
 await record(db,snapshot({event_id:'evt_closed',event_type:'charge.dispute.closed',status:'won',observed_at:'2026-02-01'}));
 await record(db,snapshot({event_id:'evt_old',status:'needs_response',observed_at:'2026-01-15'}));
 await record(db,snapshot({event_id:'evt_reinstated',event_type:'charge.dispute.funds_reinstated',status:'won',observed_at:'2026-03-01'}));
 await db.exec('reset role');
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_dispute_events')).rows[0].n,4);
 assert.equal((await db.query('select status from voice_flea_private.stripe_dispute_reviews')).rows[0].status,'won');
 assert.deepEqual((await db.query('select status,amount_jpy,refunded_amount_jpy,platform_fee_jpy,seller_amount_jpy,stripe_dispute_review_required from payments where id=$1',[p])).rows[0],{status:'paid',amount_jpy:1000,refunded_amount_jpy:0,platform_fee_jpy:150,seller_amount_jpy:850,stripe_dispute_review_required:true});
 await assert.rejects(db.query('update payments set stripe_dispute_review_required=false where id=$1',[p]),/review required/);
 await assert.rejects(db.query('delete from payments where id=$1',[p]),/review required/);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
 const summary=(await db.query('select public.seller_finance_summary() s')).rows[0].s;assert.equal(summary.payout,0);assert.equal(summary.stripe_dispute_review,1);
 const r=(await db.query('select public.stripe_dispute_review_status() s')).rows[0].s;assert.equal(r.count,1);assert.equal(r.rows[0].role,'seller');assert.equal(r.rows[0].disputeId,undefined);
 await assert.rejects(db.query('select public.stripe_dispute_review_status(true)'),/Operator required/);
 await db.exec(`set request.jwt.claim.sub='${other}'`);assert.equal((await db.query('select public.stripe_dispute_review_status() s')).rows[0].s.count,0);
 }finally{await db.close();}
});
test('bad owner/environment/charge/amount/replay denied and missing purchase retried atomically',async()=>{
 const {db}=await setup();try{
 await db.exec('set role service_role');
 for(const patch of [{buyer_id:other},{seller_id:other},{charge_id:'ch_other'},{destination:'acct_other'},{livemode:false},{charge_amount_jpy:999},{listing_id:null},{payment_intent_id:'pi_missing'}])await assert.rejects(record(db,snapshot(patch)),/mismatch|pending/);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_dispute_events')).rows[0].n,0);
 await db.exec('set role service_role');await record(db,snapshot());await assert.rejects(record(db,snapshot({event_type:'charge.dispute.closed'})),/replay identity/);
 await db.exec('reset role;set role authenticated');await assert.rejects(record(db,snapshot()),/permission denied/);
 await assert.rejects(db.query('select * from voice_flea_private.stripe_dispute_events'),/permission denied/);
 await assert.rejects(db.query('select voice_flea_private.stripe_previous_prepare_account_deletion($1)',[buyer]),/permission denied/);
 }finally{await db.close();}
});
test('late dispute blocks new receipt confirmation and both deletion checkpoints, not existing access predicate',async()=>{
 const {db,p}=await setup();try{
 const c=(await db.query("insert into conversations(listing_id,buyer_id,seller_id,payment_id,delivery_status,delivery_path) values($1,$2,$3,$4,'submitted','purchase/voice.m4a') returning id",[listing,buyer,seller,p])).rows[0].id;
 await db.exec('set role service_role');await record(db,snapshot({status:'lost',event_type:'charge.dispute.funds_withdrawn'}));
 await assert.rejects(db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,c]),/review required/);
 await assert.rejects(db.query('select public.finalize_delivery_acceptance($1,$2,$3)',[buyer,c,'tr_test']),/review required/);
 for(const name of ['prepare_account_deletion','finish_account_deletion'])for(const actor of [buyer,seller])await assert.rejects(db.query(`select public.${name}($1)`,[actor]),/review required/);
 await db.exec('reset role');
 // Existing download authority is unchanged. This hold is not a revocation of purchased content.
 assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) ok from payments p where id=$1',[p])).rows[0].ok,true);
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
 const r=(await db.query('select public.stripe_dispute_review_status(true) s')).rows[0].s;assert.equal(r.rows[0].status,'lost');assert.equal(r.rows[0].recoveryState,'unverified');assert.equal(r.rows[0].feesJpy,null);
 }finally{await db.close();}
});
test('separate partial/full refunds cannot clear a dispute hold or turn disputed amount into recovered funds',async()=>{
 const {db,p}=await setup();try{
 await db.exec('set role service_role');await record(db,snapshot());
 await assert.rejects(record(db,snapshot({platform_id:'acct_other',event_id:'evt_other'})),/platform binding/);
 await db.exec('reset role');await db.query("update payments set status='partially_refunded',refunded_amount_jpy=100 where id=$1",[p]);
 await db.exec('set role service_role');await record(db,snapshot({event_id:'evt_updated',event_type:'charge.dispute.updated',status:'lost',refunded_amount_jpy:100,observed_at:'2026-04-01'}));
 await db.exec('reset role');await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[p]);
 assert.equal((await db.query('select stripe_dispute_review_required from payments where id=$1',[p])).rows[0].stripe_dispute_review_required,true);
 await assert.rejects(db.query('select public.finish_account_deletion($1)',[seller]),/review required/);
 assert.equal((await db.query('select amount_jpy from voice_flea_private.stripe_dispute_reviews')).rows[0].amount_jpy,500);
 }finally{await db.close();}
});
test('known acceptance transfer and conflicting fresh provider IDs are preserved and flagged, never silently substituted',async()=>{
 const {db,p}=await setup();try{
 const c=(await db.query("insert into conversations(listing_id,buyer_id,seller_id,payment_id,delivery_status,delivery_path) values($1,$2,$3,$4,'submitted','purchase/voice.m4a') returning id",[listing,buyer,seller,p])).rows[0].id;
 await db.exec('set role service_role');await db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,c]);
 await db.query('select public.finalize_delivery_acceptance($1,$2,$3)',[buyer,c,'tr_known']);
 await record(db,snapshot({transfer_id:'tr_conflicting'}));await record(db,snapshot({transfer_id:'tr_conflicting'}));
 await db.exec('reset role');
 const review=()=>db.query('select transfer_id,known_transfer_ids,transfer_evidence_conflict from voice_flea_private.stripe_dispute_reviews').then(r=>r.rows[0]);
 assert.deepEqual(await review(),{transfer_id:'tr_conflicting',known_transfer_ids:['tr_known'],transfer_evidence_conflict:true});
 const evidence=(await db.query('select evidence from voice_flea_private.stripe_dispute_events')).rows[0].evidence;
 assert.equal(evidence.transfer_id,'tr_conflicting');assert.deepEqual(evidence.known_transfer_ids,['tr_known']);assert.equal(evidence.transfer_evidence_conflict,true);
 assert.equal((await db.query('select transfer_id from voice_flea_private.delivery_acceptances')).rows[0].transfer_id,'tr_known');
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_dispute_events')).rows[0].n,1);
 await db.exec('set role service_role');
 await record(db,snapshot({event_id:'evt_agree',transfer_id:'tr_known',observed_at:'2026-04-01'}));
 await record(db,snapshot({event_id:'evt_older',transfer_id:'tr_stale',observed_at:'2026-02-01'}));
 await db.exec('reset role');assert.deepEqual(await review(),{transfer_id:'tr_known',known_transfer_ids:['tr_known'],transfer_evidence_conflict:true});
 await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);
 const op=(await db.query('select public.stripe_dispute_review_status(true) s')).rows[0].s.rows[0];
 assert.deepEqual(op.knownTransferIds,['tr_known']);assert.equal(op.transferId,'tr_known');assert.equal(op.transferEvidenceConflict,true);assert.equal(op.recoveryState,'unverified');
 const owner=(await db.query('select public.stripe_dispute_review_status() s')).rows[0].s.rows[0];assert.equal(owner.knownTransferIds,undefined);assert.equal(owner.transferEvidenceConflict,undefined);
 }finally{await db.close();}
});
test('matching known transfer is not a conflict, but a later missing provider reference is durable conflicting evidence',async()=>{
 const {db,p}=await setup();try{
 const c=(await db.query("insert into conversations(listing_id,buyer_id,seller_id,payment_id,delivery_status,delivery_path) values($1,$2,$3,$4,'submitted','purchase/voice.m4a') returning id",[listing,buyer,seller,p])).rows[0].id;
 await db.exec('set role service_role');await db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,c]);await db.query('select public.finalize_delivery_acceptance($1,$2,$3)',[buyer,c,'tr_known']);
 await record(db,snapshot({transfer_id:'tr_known'}));await db.exec('reset role');
 assert.equal((await db.query('select transfer_evidence_conflict from voice_flea_private.stripe_dispute_reviews')).rows[0].transfer_evidence_conflict,false);
 await db.exec('set role service_role');await record(db,snapshot({event_id:'evt_missing',transfer_id:null,observed_at:'2026-04-01'}));await db.exec('reset role');
 const r=(await db.query('select transfer_id,known_transfer_ids,transfer_evidence_conflict from voice_flea_private.stripe_dispute_reviews')).rows[0];assert.equal(r.transfer_id,null);assert.deepEqual(r.known_transfer_ids,['tr_known']);assert.equal(r.transfer_evidence_conflict,true);
 }finally{await db.close();}
});
test('replayed event keeps its first journal but retains and flags newly retrieved provider transfer conflicts',async()=>{
 const {db}=await setup();try{
 await db.exec('set role service_role');await record(db,snapshot({transfer_id:'tr_first'}));
 await record(db,snapshot({transfer_id:'tr_changed',observed_at:'2026-04-01'}));
 await record(db,snapshot({transfer_id:'tr_first',observed_at:'2026-05-01'}));
 await db.exec('reset role');
 const r=(await db.query('select transfer_id,observed_transfer_ids,transfer_evidence_conflict from voice_flea_private.stripe_dispute_reviews')).rows[0];
 assert.equal(r.transfer_id,'tr_first');assert.deepEqual(r.observed_transfer_ids,['tr_changed','tr_first']);assert.equal(r.transfer_evidence_conflict,true);
 const events=(await db.query('select evidence from voice_flea_private.stripe_dispute_events')).rows;assert.equal(events.length,1);assert.equal(events[0].evidence.transfer_id,'tr_first');
 }finally{await db.close();}
});
