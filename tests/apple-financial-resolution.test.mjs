import test from 'node:test';import assert from 'node:assert/strict';
import {adjustmentPreview,bankReceiptPreview} from '../supabase/functions/_shared/apple-financial-resolution.mjs';
import {reconcileApplePayoutFailure} from '../supabase/functions/_shared/apple-payout-events.mjs';
const id='00000000-0000-4000-8000-000000000001',rid='00000000-0000-4000-8000-000000000002';
const row={line:2,kind:'R',quantity:-1,currency:'JPY',customerCurrency:'JPY',country:'JP',sku:'com.ayuhide.koenofurima.voice.jpy1000',customerPrice:'-500.00',unitProceeds:'318.18',proceeds:'-318.18'};
const context=()=>({payment:{id,payment_channel:'ios',apple_environment:'Production',apple_verified_at:'now',amount_jpy:1000,apple_transaction_id:'123',status:'paid',refunded_amount_jpy:0},report:{id:rid,snapshot:{rows:[{...row}]}},operation:{payment_id:id,transfer_id:'tr_a',destination:'acct_s',amount_jpy:541,state:'transferred',reversed_jpy:0},allocation:{seller_amount_jpy:541,state:'allocated_unpaid'},refundReviewRequired:false});
test('partial report approval is exact factual association, not an invented seller recovery',()=>{
 const x=adjustmentPreview(context(),{reportId:rid,lineNumber:2,note:'Matched exact transaction manually',amount:999});assert.equal(x.customerRefundJpy,500);assert.equal(x.appleNetDebit,'318.18');assert.equal(x.settlementComplete,false);assert.equal(x.reviewRequired,true);assert.equal(x.sellerRecoveryJpy,undefined);
});
test('unverified/multi-unit/foreign/mismatched report evidence fails closed',()=>{
 for(const delta of [{quantity:-2},{kind:'S'},{currency:'USD'},{customerPrice:'-1001.00'},{proceeds:'-200.00'},{sku:'wrong'}]){const c=context();Object.assign(c.report.snapshot.rows[0],delta);assert.throws(()=>adjustmentPreview(c,{reportId:rid,lineNumber:2,note:'Explicit manual review'}));}
 const c=context();c.payment.apple_environment='Sandbox';assert.throws(()=>adjustmentPreview(c,{reportId:rid,lineNumber:2,note:'Explicit manual review'}));
});
test('bank preview requires original statement identity and whole payout amount; extra fees remain held',()=>{
 const input={bankStatementSha256:'a'.repeat(64),bankReference:'BANK-REF-123',receivedDate:'2026-11-01',receivedAmountJpy:2000,bankAccountId:'ba_bank',note:'Original statement and payout matched'};
 const v={transferId:'tr_a',destination:'acct_s',assignmentVerified:true,stripePayoutPaid:true,payoutAmountJpy:2000,payoutId:'po_a',balanceTransactionId:'txn_a',creditFeeJpy:0,creditNetJpy:541,batchAllPositiveNoFees:true,batchMatchesPayout:true,batchNetTotalJpy:2000};
 assert.equal(bankReceiptPreview(context(),input,v).eligibleForSettlement,true);assert.equal(bankReceiptPreview(context(),input,{...v,creditFeeJpy:1,creditNetJpy:540}).eligibleForSettlement,false);
 assert.equal(bankReceiptPreview(context(),input,{...v,batchAllPositiveNoFees:false}).eligibleForSettlement,false);assert.equal(bankReceiptPreview(context(),{...input,receivedAmountJpy:500},{...v,payoutAmountJpy:500,batchNetTotalJpy:500}).eligibleForSettlement,false);
 assert.throws(()=>bankReceiptPreview(context(),{...input,receivedAmountJpy:541},v));assert.throws(()=>bankReceiptPreview(context(),{...input,bankStatementSha256:'fake'},v));
});
test('signed-event downstream handler scopes fresh payout reads and only invalidates failed/canceled exact accounts',async()=>{
 const event={id:'evt_failed',type:'payout.failed',livemode:true,account:'acct_s',data:{object:{object:'payout',id:'po_a',livemode:true}}};let calls=[];
 const args={event,stripe:{payouts:{retrieve:async(id,params,opts)=>{calls.push({id,opts});return {object:'payout',id,livemode:true,status:'failed'}}}},db:{rpc:async(name,args)=>{calls.push({name,args});return {data:1}}}};
 assert.equal(await reconcileApplePayoutFailure(args),true);assert.equal(calls[0].opts.stripeAccount,'acct_s');assert.equal(calls[1].args.destination,'acct_s');
 for(const change of [{livemode:false},{account:undefined},{id:'bad'}]){calls=[];await assert.rejects(reconcileApplePayoutFailure({...args,event:{...event,...change}}));assert.equal(calls.length,0);}
 calls=[];args.stripe.payouts.retrieve=async()=>({object:'payout',id:'po_a',livemode:true,status:'paid'});await assert.rejects(reconcileApplePayoutFailure(args),/unconfirmed/);assert.equal(calls.length,0);
});
