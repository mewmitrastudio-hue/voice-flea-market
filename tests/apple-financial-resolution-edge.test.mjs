import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {adjustmentPreview,bankReceiptPreview} from '../supabase/functions/_shared/apple-financial-resolution.mjs';
const actor='00000000-0000-4000-8000-000000000001',payment='00000000-0000-4000-8000-000000000002',report='00000000-0000-4000-8000-000000000003',operation='00000000-0000-4000-8000-000000000004';
function fixture({foreign=false,authFail=false,bank=false,bankEnvironment='Production',mixedBatch=false,collectorFailure=false,receiptReview=false}={}){
 let handler,row=null;const calls=[];
 const context={payment:{id:payment,payment_channel:'ios',apple_environment:'Production',apple_verified_at:'now',apple_transaction_id:'123',amount_jpy:1000},report:{id:report,snapshot:{rows:[{line:2,kind:'R',quantity:-1,currency:'JPY',customerCurrency:'JPY',country:'JP',sku:'com.ayuhide.koenofurima.voice.jpy1000',customerPrice:'-500.00',unitProceeds:'318.18',proceeds:'-318.18'}]}}};
 if(bank){Object.assign(context.payment,{status:'paid',refunded_amount_jpy:0});context.operation={id:operation,payment_id:payment,platform_id:'acct_platform',destination:'acct_seller',transfer_id:'tr_test',amount_jpy:541,state:'transferred',reversed_jpy:0};context.allocation={seller_amount_jpy:541,state:'allocated_unpaid'};context.refundReviewRequired=false;}
 const trustedObservation={source:'trusted collector test'};
 const db={auth:{getUser:async()=>({data:{user:authFail?null:{id:foreign?payment:actor}}})},rpc:async(name,args)=>{
 calls.push({name,args});if(name==='get_apple_financial_review')return {data:row};if(name==='apple_financial_resolution_context')return {data:context};
 if(name==='store_apple_financial_review'){row={id:operation,kind:args.kind,state:'preview',summary:args.summary,input:args.input,preview_hash:'h'.repeat(64)};return {data:row};}
 if(name==='approve_apple_financial_review'){assert.deepEqual(args.observation,bank?trustedObservation:null);row={...row,state:'approved',terminal:bank&&args.fresh_summary.eligibleForSettlement?{state:'settled',review_id:operation}:null};return {data:row};}
 if(name==='invalidate_apple_financial_preview'){row={...row,state:'invalidated'};return {data:row};}throw Error(name);
 }};
 const c={Request,Response,Uint8Array,TextDecoder,console:{warn(){}},createClient:()=>db,Stripe:function(){if(!bank)throw Error('adjustment must not use Stripe')},adjustmentPreview,bankReceiptPreview,collectApplePayoutEvidence:()=>{if(!bank||collectorFailure)throw Error('collector unavailable');return {evidence:trustedObservation,verification:{assignmentVerified:true,stripePayoutPaid:true,transferId:'tr_test',destination:'acct_seller',payoutId:'po_test',payoutAmountJpy:541,creditFeeJpy:0,creditNetJpy:541,batchAllPositiveNoFees:!mixedBatch,batchMatchesPayout:true,batchNetTotalJpy:541,balanceTransactionId:'txn_test'}};},appleConfig:()=>({verifier:{verifiedTransactionById:async()=>({environment:bankEnvironment,transactionId:'123',productId:'com.ayuhide.koenofurima.voice.jpy1000',price:1000000,currency:'JPY'})}}),applyTransaction:()=>{if(!bank)throw Error('adjustment must not verify purchases');calls.push({name:'verified_receipt_gate'});if(receiptReview)throw Error('APPLE_REFUND_REVIEW_HELD');return {paymentId:payment,revoked:false};},Deno:{serve:f=>handler=f,env:{get:k=>({SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit',ADMIN_USER_ID:actor,STRIPE_SECRET_KEY:'sk_live_unit',APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID:'acct_platform'})[k]}}};
 const source=fs.readFileSync(new URL('../supabase/functions/apple-financial-resolution/index.ts',import.meta.url),'utf8').replace(/^import .*\n/gm,'');vm.runInNewContext(stripTypeScriptTypes(source),c);
 return {calls,context,send:(body,auth=true)=>handler(new Request('https://local.invalid',{method:'POST',headers:auth?{Authorization:'Bearer unit'}:{},body:JSON.stringify({operationId:operation,...body})}))};
}
test('manual evidence endpoint enforces identity and exposes not-found explicitly',async()=>{
 for(const options of [{authFail:true},{foreign:true}]){const f=fixture(options);assert.ok((await f.send({action:'status'})).status>=400);assert.equal(f.calls.length,0);}
 const f=fixture();assert.equal((await f.send({action:'status'},false)).status,401);const r=await f.send({action:'status'});assert.equal(r.status,404);assert.equal((await r.json()).code,'operation_not_found');
});
test('report preview and explicit approval never use client refund amounts or move money',async()=>{
 const f=fixture();let r=await f.send({action:'previewAdjustment',paymentId:payment,reportId:report,lineNumber:2,note:'Original report matched manually',customerRefundJpy:999});assert.equal(r.status,200);const preview=await r.json();assert.equal(preview.summary.customerRefundJpy,500);
 r=await f.send({action:'approve',previewHash:preview.previewHash,confirmation:false});assert.equal(r.status,409);
 r=await f.send({action:'approve',previewHash:preview.previewHash,confirmation:true});const approved=await r.json();assert.equal(approved.state,'approved');assert.equal(approved.reviewRequired,true);assert.equal(approved.settlementComplete,false);
 const n=f.calls.filter(x=>x.name==='approve_apple_financial_review').length;await f.send({action:'approve',previewHash:preview.previewHash,confirmation:true});assert.equal(f.calls.filter(x=>x.name==='approve_apple_financial_review').length,n);
});
test('changed authoritative evidence invalidates an old preview instead of approving stale facts',async()=>{
 const f=fixture();const p=await (await f.send({action:'previewAdjustment',paymentId:payment,reportId:report,lineNumber:2,note:'Original report matched manually'})).json();
 f.context.report.snapshot.rows[0].customerPrice='-400.00';const r=await f.send({action:'approve',previewHash:p.previewHash,confirmation:true});assert.equal((await r.json()).state,'invalidated');assert.equal(f.calls.some(x=>x.name==='approve_apple_financial_review'),false);
});

test('bank approval uses fresh trusted collector evidence, not client observations, and exposes manual receipt approval accurately',async()=>{
 const f=fixture({bank:true});const preview=await (await f.send({action:'previewBankReceipt',paymentId:payment,payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'BANK-REF',receivedDate:'2026-11-01',receivedAmountJpy:541,note:'Matched original bank statement',observation:{forged:true}})).json();
 assert.equal(preview.summary.eligibleForSettlement,true);const stored=f.calls.find(x=>x.name==='store_apple_financial_review');assert.equal(stored.args.observation.source,'trusted collector test');
 const result=await (await f.send({action:'approve',previewHash:preview.previewHash,confirmation:true})).json();assert.equal(result.settlementComplete,true);assert.equal(result.summary.operatorBankReceiptApproved,true);assert.equal(result.reviewRequired,false);
});

test('bank endpoint rejects Sandbox evidence and failed collectors without creating an approval',async()=>{
 const input={action:'previewBankReceipt',paymentId:payment,payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'BANK-REF',receivedDate:'2026-11-01',receivedAmountJpy:541,note:'Matched original bank statement'};
 for(const options of [{bankEnvironment:'Sandbox'},{collectorFailure:true}]){const f=fixture({bank:true,...options});assert.equal((await f.send(input)).status,409);assert.equal(f.calls.some(x=>x.name==='store_apple_financial_review'||x.name==='approve_apple_financial_review'),false);}
});
test('a mixed bank batch can record operator evidence but remains an unresolved liability',async()=>{
 const f=fixture({bank:true,mixedBatch:true});const p=await (await f.send({action:'previewBankReceipt',paymentId:payment,payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'BANK-REF',receivedDate:'2026-11-01',receivedAmountJpy:541,note:'Matched original bank statement'})).json();assert.equal(p.summary.eligibleForSettlement,false);
 const result=await (await f.send({action:'approve',previewHash:p.previewHash,confirmation:true})).json();assert.equal(result.state,'approved');assert.equal(result.settlementComplete,false);assert.equal(result.reviewRequired,true);
});

test('bank receipt preview cannot bypass durable receipt review with a positive current Apple payload',async()=>{
 const f=fixture({bank:true,receiptReview:true});
 const r=await f.send({action:'previewBankReceipt',paymentId:payment,payoutId:'po_test',bankAccountId:'ba_test',bankStatementSha256:'a'.repeat(64),bankReference:'BANK-REF',receivedDate:'2026-11-01',receivedAmountJpy:541,note:'Synthetic evidence'});
 assert.equal(r.status,409);assert(f.calls.some(x=>x.name==='verified_receipt_gate'));assert(!f.calls.some(x=>x.name==='store_apple_financial_review'||x.name==='approve_apple_financial_review'));
});
