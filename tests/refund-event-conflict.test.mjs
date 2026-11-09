import test from 'node:test';import assert from 'node:assert/strict';
import {refundDatabase,dbAdapter} from './fixtures/refund-dispatch-database.mjs';
import {provider,run} from './fixtures/refund-provider.mjs';
import {reconcileStripeRefundEvent} from '../supabase/functions/_shared/stripe-refund-dispatch.mjs';
for(const initial of ['succeeded','pending'])for(const status of ['failed','requires_action'])test(initial+' then adverse '+status+' event/current succeeded preserves both and never certifies conflict',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p,{status:initial});await run(db,p,f);f.setStatus('succeeded');f.setRefunded(1000);
 const event={id:'evt_adverse',type:status==='failed'?'refund.failed':'refund.updated',livemode:true,created:123,data:{object:{object:'refund',id:'re_unit',payment_intent:p.stripe_payment_intent_id,charge:p.stripe_charge_id,currency:'jpy',amount:1000,status,failure_balance_transaction:'txn_returned',failure_reason:'declined'}}};
 assert.equal(await reconcileStripeRefundEvent({event,db:dbAdapter(db),stripe:f.stripe,live:true,platformId:'acct_platform'}),true);
 const o=(await db.query('select * from voice_flea_private.stripe_refund_operations')).rows[0];
 assert.equal(o.state,'needs_review');assert.equal(o.buyer_refund_verified,false);assert.equal(o.provider_evidence_review,true);
 const e=(await db.query('select evidence from voice_flea_private.stripe_refund_observations order by id desc limit 1')).rows[0].evidence;
 assert.equal(e.refund_status,'succeeded');assert.equal(e.verified_event.refund_status,status);assert.equal(e.verified_event.failure_balance_transaction,'txn_returned');assert.equal(e.event_current_conflict,true);
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_verified_refund_facts')).rows[0].n,initial==='succeeded'?1:0);
 const later=await run(db,p,f);assert.equal(later.buyer_refund_verified,false);assert.equal(later.review_required,true);assert.equal(f.posts,1);
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_verified_refund_facts')).rows[0].n,initial==='succeeded'?1:0);
 }finally{await db.close();}
});
