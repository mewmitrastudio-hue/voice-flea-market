import test from 'node:test';import assert from 'node:assert/strict';
import {refundDatabase,dbAdapter,prepareArgs,buyer,seller} from './fixtures/refund-dispatch-database.mjs';
const call=async(db,n,args)=>{const r=await dbAdapter(db).rpc(n,args);if(r.error)throw r.error;return r.data;};
const proof={refund_currency:'jpy',refund_charge_id:'ch_refund',refund_payment_intent_id:'pi_refund'};
const observation=p=>({currency:'jpy',stripe_payment_intent_id:p.stripe_payment_intent_id,stripe_charge_id:p.stripe_charge_id,stripe_livemode:true,amount_jpy:1000,refunded_amount_jpy:0,disputed:false,refunded:false,destination:'acct_seller',application_fee_jpy:150,stripe_reconciled_at:new Date().toISOString()});
const params={payment_intent:'pi_refund',reverse_transfer:'true',refund_application_fee:'true'};
const prep=(db,p)=>call(db,'prepare_stripe_refund',prepareArgs(p));
const claim=(db,p,o,extra={})=>call(db,'claim_stripe_refund_dispatch',{...prepareArgs(p),operation_id:o.id,parameters:params,observation:observation(p),...extra});
test('permanent manual/auto shared operation dispatches once; authenticated clients cannot claim',async()=>{
 const {db,p}=await refundDatabase();try{
 await db.exec('set role service_role');const a=await prep(db,p),b=await prep(db,p);assert.equal(a.id,b.id);assert.equal((await claim(db,p,a)).dispatch_granted,true);assert.equal((await claim(db,p,b)).dispatch_granted,false);
 await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${buyer}'`);await assert.rejects(prep(db,p),/permission denied/);await assert.rejects(db.query('select * from voice_flea_private.stripe_refund_operations'),/permission denied/);
 }finally{await db.close();}
});
test('hold arriving after prepare, parameter drift, partial and pre-cutover histories block dispatch',async()=>{
 for(const kind of ['hold','parameters','partial','legacy']){const {db,p}=await refundDatabase();try{
 if(kind==='legacy')await db.exec("update payments set created_at=now()-interval '2 days'");
 if(kind==='partial')await db.exec("update payments set status='partially_refunded',refunded_amount_jpy=100");
 const o=await prep(db,p);if(kind==='hold')await db.exec('update payments set stripe_dispute_review_required=true');
 const result=await claim(db,p,o,kind==='parameters'?{parameters:{...params,amount:'1000'}}:{});assert.equal(result.dispatch_granted,false);assert.equal(result.state,'needs_review');assert.equal(result.dispatched_at,null);
 }finally{await db.close();}}
});
test('verified full buyer refund under a new hold remains a financial fact, not a normal completion notification',async()=>{
 const {db,p,job}=await refundDatabase();try{
 const jobs=await call(db,'refund_auto_claim',{provided_token:'unit-worker-only'});const o=await prep(db,p);await claim(db,p,o);
 await db.exec('update payments set stripe_dispute_review_required=true');
 const r=await call(db,'record_stripe_refund_outcome',{operation_id:o.id,evidence:{...proof,refund_id:'re_verified',refund_status:'succeeded',refund_amount_jpy:1000,observation:{...observation(p),refunded_amount_jpy:1000,refunded:true},error_code:null}});
 assert.equal(r.buyer_refund_verified,true);assert.equal(r.state,'needs_review');
 await call(db,'refund_auto_result',{job_id:job,lease:jobs[0].lease_id,refund_id:'re_verified',refund_status:'succeeded',error_code:null,permanent:false});
 assert.equal((await db.query('select status,refunded_amount_jpy from payments')).rows[0].status,'refunded');assert.equal((await db.query('select state from voice_flea_private.refund_auto_jobs')).rows[0].state,'needs_review');assert.equal((await db.query('select count(*)::int n from voice_flea_private.app_mail_outbox')).rows[0].n,0);
 }finally{await db.close();}
});
test('disabled gates, wrong mode, iOS evidence and worker authentication fail closed independently',async()=>{
 const {db,p}=await refundDatabase();try{
 await assert.rejects(call(db,'refund_auto_claim',{provided_token:'wrong'}),/access required/);
 await assert.rejects(call(db,'prepare_stripe_refund',{...prepareArgs(p),live:false}),/channel or mode/);
 await db.exec('update voice_flea_private.stripe_refund_dispatch_config set enabled=false');await assert.rejects(prep(db,p),/disabled/);await assert.rejects(call(db,'refund_auto_claim',{provided_token:'unit-worker-only'}),/disabled/);
 await db.exec("update voice_flea_private.stripe_refund_dispatch_config set enabled=true;update payments set payment_channel='ios',stripe_checkout_session_id=null,stripe_payment_intent_id=null,stripe_charge_id=null,stripe_livemode=null,stripe_reconciled_at=null,apple_transaction_id='123',apple_environment='Production',apple_verified_at=now(),platform_fee_jpy=null,seller_amount_jpy=null");
 await assert.rejects(prep(db,p),/channel or mode/);
 }finally{await db.close();}
});
test('auto claim adds hold gating and dispatch revalidates bilateral approval and lease after job claim',async()=>{
 const {db,p}=await refundDatabase();try{
 const jobs=await call(db,'refund_auto_claim',{provided_token:'unit-worker-only'}),job=jobs[0];const args={...prepareArgs(p),origin:'auto',actor:null,job_id:job.id,lease:job.lease_id};
 const o=await call(db,'prepare_stripe_refund',args);
 await db.exec('update voice_flea_private.trade_cancellations set seller_approved=false');
 await assert.rejects(call(db,'claim_stripe_refund_dispatch',{...args,operation_id:o.id,parameters:params,observation:observation(p)}),/approval or lease changed/);
 await db.exec("update voice_flea_private.trade_cancellations set seller_approved=true;update voice_flea_private.refund_auto_jobs set lease_until=now()-interval '1 second'");
 await assert.rejects(call(db,'claim_stripe_refund_dispatch',{...args,operation_id:o.id,parameters:params,observation:observation(p)}),/approval or lease changed/);
 await db.exec('update payments set stripe_dispute_review_required=true');assert.deepEqual(await call(db,'refund_auto_claim',{provided_token:'unit-worker-only'}),[]);
 }finally{await db.close();}
});
test('late outcome persists across job lease replacement, and current verified result uses original notification dedupe',async()=>{
 const {db,p,job}=await refundDatabase();try{
 const jobs=await call(db,'refund_auto_claim',{provided_token:'unit-worker-only'});const oldLease=jobs[0].lease_id,o=await prep(db,p);await claim(db,p,o);
 await db.exec("update voice_flea_private.refund_auto_jobs set lease_id=gen_random_uuid(),lease_until=now()+interval '90 seconds'");
 const lease=(await db.query('select lease_id from voice_flea_private.refund_auto_jobs')).rows[0].lease_id;
 await call(db,'record_stripe_refund_outcome',{operation_id:o.id,evidence:{...proof,refund_id:'re_verified',refund_status:'succeeded',refund_amount_jpy:1000,observation:{...observation(p),refunded_amount_jpy:1000,refunded:true},error_code:null}});
 await call(db,'refund_auto_result',{job_id:job,lease:oldLease,refund_id:'re_verified',refund_status:'succeeded',error_code:null,permanent:false});
 assert.equal((await db.query('select state from voice_flea_private.refund_auto_jobs')).rows[0].state,'processing');assert.equal((await db.query('select buyer_refund_verified from voice_flea_private.stripe_refund_operations')).rows[0].buyer_refund_verified,true);
 await call(db,'refund_auto_result',{job_id:job,lease,refund_id:'re_verified',refund_status:'succeeded',error_code:null,permanent:false});
 assert.equal((await db.query('select state from voice_flea_private.refund_auto_jobs')).rows[0].state,'succeeded');assert.equal((await db.query('select count(*)::int n from voice_flea_private.app_mail_outbox')).rows[0].n,2);
 await call(db,'refund_auto_result',{job_id:job,lease,refund_id:'re_verified',refund_status:'succeeded',error_code:null,permanent:false});assert.equal((await db.query('select count(*)::int n from voice_flea_private.app_mail_outbox')).rows[0].n,2);
 }finally{await db.close();}
});
test('known unresolved refund blocks receipt advancement and both deletion checkpoints without changing content rights',async()=>{
 const {db,p,c}=await refundDatabase();try{
 const o=await prep(db,p);await claim(db,p,o);
 for(const target of [buyer,seller]){assert.equal((await call(db,'prepare_account_deletion',{target})).allowed,false);await assert.rejects(call(db,'finish_account_deletion',{target}),/Refund result review/);}
 await assert.rejects(call(db,'prepare_delivery_acceptance',{actor:buyer,trade_id:c}),/Refund result review/);
 await assert.rejects(call(db,'finalize_delivery_acceptance',{actor:buyer,trade_id:c,transfer:'tr_known'}),/Refund result review/);
 assert.equal((await db.query('select voice_flea_private.verified_voice_payment(p) ok from payments p')).rows[0].ok,true);
 }finally{await db.close();}
});
test('an older full refund observation cannot claim success against a newer contradictory payment reconciliation',async()=>{
 const {db,p}=await refundDatabase();try{
 const o=await prep(db,p);await claim(db,p,o);
 const old={...observation(p),stripe_reconciled_at:new Date(Date.now()-5000).toISOString(),refunded_amount_jpy:1000,refunded:true};
 const r=await call(db,'record_stripe_refund_outcome',{operation_id:o.id,evidence:{...proof,refund_id:'re_old',refund_status:'succeeded',refund_amount_jpy:1000,observation:old,error_code:null}});
 assert.equal(r.state,'needs_review');assert.equal(r.buyer_refund_verified,false);assert.equal(r.error_code,'refund_reconciliation_pending');assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
 assert.equal((await db.query('select count(*)::int n from voice_flea_private.stripe_refund_observations')).rows[0].n,1);
 }finally{await db.close();}
});
