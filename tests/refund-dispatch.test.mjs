import test from 'node:test';import assert from 'node:assert/strict';
import {refundDatabase,dbAdapter,buyer} from './fixtures/refund-dispatch-database.mjs';
import {dispatchStripeRefund} from '../supabase/functions/_shared/stripe-refund-dispatch.mjs';
import {provider,run} from './fixtures/refund-provider.mjs';
test('manual and auto use one durable dispatch and exact provider response/charge evidence',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p);const r=await run(db,p,f);assert.equal(r.dispatch_state,'succeeded');assert.equal(r.status,'succeeded');assert.equal(f.posts,1);
 await run(db,p,f);assert.equal(f.posts,1);assert.equal((await db.query('select status from payments')).rows[0].status,'refunded');
 }finally{await db.close();}
});
test('unknown POST survives elapsed time and concurrent retries without another POST',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p,{unknown:true});const first=await run(db,p,f);assert.equal(first.review_required,true);assert.equal(f.posts,1);
 await db.exec("update voice_flea_private.stripe_refund_operations set dispatched_at=now()-interval '3 days'");
 await Promise.all([run(db,p,f),run(db,p,f)]);assert.equal(f.posts,1);
 const row=(await db.query('select status,refunded_amount_jpy from payments')).rows[0];assert.equal(row.status,'refunded');assert.equal(row.refunded_amount_jpy,1000);
 assert.equal((await db.query('select buyer_refund_verified from voice_flea_private.stripe_refund_operations')).rows[0].buyer_refund_verified,false);
 }finally{await db.close();}
});
test('hold committed immediately before dispatch prevents POST; hold during POST preserves refund fact and review',async()=>{
 for(const phase of ['before','during']){const {db,p}=await refundDatabase();try{
 const hold=()=>db.exec('update payments set stripe_dispute_review_required=true');
 const f=provider(p,phase==='before'?{beforeClaim:hold}:{holdDuringPost:hold});const r=await run(db,p,f);
 assert.equal(r.review_required,true);assert.equal(f.posts,phase==='before'?0:1);
 assert.equal((await db.query('select status from payments')).rows[0].status,phase==='before'?'paid':'refunded');
 }finally{await db.close();}}
});
test('pending and requires_action are durable nonterminal outcomes with no repeat dispatch',async()=>{
 for(const status of ['pending','requires_action']){const {db,p}=await refundDatabase();try{
 const f=provider(p,{status});const r=await run(db,p,f);assert.equal(r.status,status);assert.equal(r.dispatch_state,status==='pending'?'pending':'needs_review');await run(db,p,f);assert.equal(f.posts,1);
 }finally{await db.close();}}
});
test('provider parameter conflict stays visible and cannot trigger a changed-parameter/new-key retry',async()=>{
 const {db,p}=await refundDatabase();try{
 const f=provider(p,{errorResponse:{error:{type:'idempotency_error'}}});const r=await run(db,p,f);assert.equal(r.error_code,'provider_parameter_conflict');await run(db,p,f);assert.equal(f.posts,1);assert.equal((await db.query('select parameter_conflict from voice_flea_private.stripe_refund_operations')).rows[0].parameter_conflict,true);
 }finally{await db.close();}
});
test('manual wrong provider mode/charge and pre-existing refund history never dispatch; malformed response is not success',async()=>{
 for(const options of [{pi:{livemode:false}},{existing:[{id:'re_pending'}]},{refund:{charge:'ch_foreign'}},{refund:{amount:500}}]){
 const {db,p}=await refundDatabase();try{const f=provider(p,options);const r=await run(db,p,f);assert.equal(r.review_required,true);assert.equal(r.status,'unknown');assert.equal(f.posts,options.refund?1:0);await run(db,p,f);assert.equal(f.posts,options.refund?1:0);}finally{await db.close();}}
});
test('competing authenticated manual and claimed automatic paths cannot issue two refund POSTs',async()=>{
 const {db,p}=await refundDatabase();try{
 const job=(await dbAdapter(db).rpc('refund_auto_claim',{provided_token:'unit-worker-only'})).data[0];const f=provider(p);
 await Promise.all([run(db,p,f),run(db,p,f,{origin:'auto',actor:null,jobId:job.id,lease:job.lease_id})]);assert.equal(f.posts,1);assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_refund_operations')).rows[0].n,1);
 }finally{await db.close();}
});
