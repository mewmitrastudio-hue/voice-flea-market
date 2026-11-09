import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {refundDatabase,dbAdapter} from './fixtures/refund-dispatch-database.mjs';import {provider,run} from './fixtures/refund-provider.mjs';
import {reconcileStripeRefundEvent} from '../supabase/functions/_shared/stripe-refund-dispatch.mjs';
const payment=db=>db.query('select status,refunded_amount_jpy,stripe_refund_fact_review_required,voice_flea_private.verified_voice_payment(p) paid_eligible,voice_flea_private.verified_voice_refund(p) refund_complete from payments p').then(r=>r.rows[0]);
test('verified historical full refund survives later zero/partial observations without restoring rights or asserting current success',async()=>{
 for(const amount of [0,500]){const {db,p}=await refundDatabase();try{
 const f=provider(p);assert.equal((await run(db,p,f)).buyer_refund_verified,true);
 const proof=(await db.query('select * from voice_flea_private.stripe_verified_refund_facts')).rows[0];assert.equal(proof.amount_jpy,1000);
 f.setRefunded(amount);const r=await run(db,p,f);assert.equal(r.review_required,true);assert.equal(r.buyer_refund_verified,false);assert.equal(r.historical_refund_review,true);assert.equal(f.posts,1);
 assert.deepEqual(await payment(db),{status:'refunded',refunded_amount_jpy:1000,stripe_refund_fact_review_required:true,paid_eligible:false,refund_complete:false});
 assert.deepEqual((await db.query('select * from voice_flea_private.stripe_verified_refund_facts')).rows[0],proof);
 assert.equal((await db.query('select evidence from voice_flea_private.stripe_refund_fact_conflicts')).rows[0].evidence.attempted_refunded_amount_jpy,amount);
 f.setRefunded(1000);assert.equal((await run(db,p,f)).review_required,true);assert.equal(f.posts,1);
 }finally{await db.close();}}
});
test('legitimate later failed/requires_action evidence is retained separately and never presented as current successful refund',async()=>{
 for(const status of ['failed','requires_action']){const {db,p}=await refundDatabase();try{
 const f=provider(p);await run(db,p,f);f.setStatus(status);f.setFailure();f.setRefunded(status==='failed'?0:1000);
 const r=await run(db,p,f);assert.equal(r.status,status);assert.equal(r.review_required,true);assert.equal(r.buyer_refund_verified,false);assert.equal((await payment(db)).paid_eligible,false);
 const last=(await db.query('select evidence from voice_flea_private.stripe_refund_observations order by id desc limit 1')).rows[0].evidence;
 assert.equal(last.failure_balance_transaction,'txn_returned');assert.equal(last.refund_status,status);assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_verified_refund_facts')).rows[0].n,1);
 }finally{await db.close();}}
});
test('pending or initially failed activity is never promoted into a historical verified full refund',async()=>{
 for(const status of ['pending','failed']){const {db,p}=await refundDatabase();try{
 const f=provider(p,{status});const r=await run(db,p,f);assert.equal(r.buyer_refund_verified,false);assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_verified_refund_facts')).rows[0].n,0);assert.equal((await payment(db)).refunded_amount_jpy,0);
 }finally{await db.close();}}
});
test('common snapshot and prewarmed caller retain financial history; existing snapshot function OID is unchanged',async()=>{
 const {db,p}=await refundDatabase({monotonic:false});try{
 const oid=(await db.query("select 'public.record_stripe_payment_snapshot(jsonb)'::regprocedure::oid n")).rows[0].n;
 await db.exec('create function public.prewarmed_refund_snapshot(s jsonb) returns void language sql as $$select public.record_stripe_payment_snapshot(s)$$');
 const snapshot={stripe_payment_intent_id:p.stripe_payment_intent_id,stripe_charge_id:p.stripe_charge_id,stripe_livemode:true,amount_jpy:1000,refunded_amount_jpy:0,stripe_reconciled_at:new Date().toISOString()};
 await db.query('select public.prewarmed_refund_snapshot($1)',[snapshot]);
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261109060227_preserve_verified_stripe_refund_facts.sql',import.meta.url),'utf8'));
 assert.equal((await db.query("select 'public.record_stripe_payment_snapshot(jsonb)'::regprocedure::oid n")).rows[0].n,oid);
 const f=provider(p);await run(db,p,f);await db.query('select public.prewarmed_refund_snapshot($1)',[{...snapshot,stripe_reconciled_at:new Date().toISOString()}]);
 assert.equal((await payment(db)).refunded_amount_jpy,1000);assert.equal((await payment(db)).stripe_refund_fact_review_required,true);
 await assert.rejects(db.exec('delete from voice_flea_private.stripe_verified_refund_facts'),/append-only/);await assert.rejects(db.exec('delete from payments'),/history must be retained/);
 }finally{await db.close();}
});
test('refund webhook reconciliation is read-only and captures current failed status even when charge total remains full',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p);await run(db,p,f);f.setStatus('failed');f.setFailure();
 const event={type:'refund.failed',livemode:true,data:{object:{id:'re_unit',object:'refund',payment_intent:p.stripe_payment_intent_id,charge:p.stripe_charge_id,amount:p.amount_jpy,currency:'jpy',status:'failed',failure_balance_transaction:'txn_returned',failure_reason:'declined'}}};
 assert.equal(await reconcileStripeRefundEvent({event,db:dbAdapter(db),stripe:f.stripe,live:true,platformId:'acct_platform'}),true);
 assert.equal(f.posts,1);const r=(await db.query('select refund_status,buyer_refund_verified,historical_refund_review,state from voice_flea_private.stripe_refund_operations')).rows[0];assert.equal(r.refund_status,'failed');assert.equal(r.buyer_refund_verified,false);assert.equal(r.historical_refund_review,true);assert.equal(r.state,'needs_review');
 }finally{await db.close();}
});
test('SQL rejects missing currency, amount and charge proof instead of inventing a verified historical refund',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p,{status:'pending'});await run(db,p,f);
 const id=(await db.query('select id from voice_flea_private.stripe_refund_operations')).rows[0].id;
 const good={refund_id:'re_unit',refund_status:'succeeded',refund_amount_jpy:1000,refund_currency:'jpy',refund_charge_id:p.stripe_charge_id,refund_payment_intent_id:p.stripe_payment_intent_id,observation:{currency:'jpy',stripe_payment_intent_id:p.stripe_payment_intent_id,stripe_charge_id:p.stripe_charge_id,stripe_livemode:true,amount_jpy:1000,refunded_amount_jpy:1000,refunded:true,stripe_reconciled_at:new Date().toISOString()}};
 for(const evidence of [{...good,refund_currency:'usd'},{...good,refund_charge_id:'ch_other'},{...good,observation:{...good.observation,currency:null}},{...good,observation:{...good.observation,amount_jpy:2000}}]){
 const r=await dbAdapter(db).rpc('record_stripe_refund_outcome',{operation_id:id,evidence});assert.ok(r.error);
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_verified_refund_facts')).rows[0].n,0);
 assert.equal((await payment(db)).refunded_amount_jpy,0);
 }
 await db.exec('set role authenticated');
 await assert.rejects(db.query('select * from voice_flea_private.stripe_verified_refund_facts'),/permission denied/);
 await assert.rejects(db.query("select public.get_stripe_refund_operation('re_unit','pi_refund',true)"),/permission denied/);
 }finally{await db.close();}
});
