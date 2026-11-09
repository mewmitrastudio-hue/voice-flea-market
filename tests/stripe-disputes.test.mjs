import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileStripeDispute,stripeDisputeEvents} from '../supabase/functions/_shared/stripe-disputes.mjs';
import {fixture} from './fixtures/stripe-dispute.mjs';
test('all five dispute types retrieve current state, never execute a money endpoint',async()=>{
 for(const type of stripeDisputeEvents){const f=fixture();f.event.type=type;f.objects['disputes/dp_test'].status='won';await reconcileStripeDispute(f);
 assert.equal(f.snapshot().status,'won');assert.equal(f.snapshot().amount_jpy,500);assert.equal(f.snapshot().refunded_amount_jpy,0);assert.equal(f.calls.length,5);assert.equal(f.calls.at(-1),'record_stripe_dispute_observation');}
});
test('connected account, context, platform, missing mode and conflicting provider identities fail closed',async()=>{
 const cases=[f=>f.event.account='acct_other',f=>f.event.context='acct_other',f=>f.platformId='',f=>f.event.livemode=false,f=>f.event.id='',
 f=>f.objects.account.id='acct_other',f=>f.objects['disputes/dp_test'].charge='ch_other',f=>f.objects['disputes/dp_test'].payment_intent='pi_other',
 f=>f.objects['charges/ch_test'].livemode=false,f=>f.objects['charges/ch_test'].amount_captured=900,f=>f.objects['payment_intents/pi_test'].latest_charge='ch_other',
 f=>f.objects['payment_intents/pi_test'].transfer_data.destination=null,f=>f.objects['disputes/dp_test'].evidence_details.due_by='bad'];
 for(const change of cases){const f=fixture();change(f);await assert.rejects(reconcileStripeDispute(f));assert.equal(f.snapshot(),undefined);}
});
test('unknown provider status stays reviewable; persistence/read failure is never acknowledged as saved',async()=>{
 const f=fixture();f.objects['disputes/dp_test'].status='future_provider_state';await reconcileStripeDispute(f);assert.equal(f.snapshot().status,'future_provider_state');
 f.db.rpc=async()=>({error:true});await assert.rejects(reconcileStripeDispute(f),/persistence/);
 f.get=async()=>{throw Error('offline')};await assert.rejects(reconcileStripeDispute(f),/offline/);
});
