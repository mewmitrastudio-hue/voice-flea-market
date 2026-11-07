import {test} from 'node:test';import assert from 'node:assert/strict';
import {verifyApplePayoutEvidence as verify} from '../supabase/functions/_shared/apple-payout-evidence.mjs';
function fixture(){
 const expected={platformId:'acct_platform',destination:'acct_seller',transferId:'tr_1',payoutId:'po_1',bankAccountId:'ba_1',currency:'jpy',livemode:true,amountJpy:850,settlementId:'00000000-0000-4000-8000-000000000001',paymentId:'00000000-0000-4000-8000-000000000002'};
 const envelope=(data,accountId)=>({data,context:{source:'stripe_server_api',accountId,livemode:true,requestId:'req_1',apiVersion:'2026-09-30.endive',retrievedAtMs:1000}});
 return {expected,nowMs:1100,maxAgeMs:200,
 transfer:envelope({object:'transfer',id:'tr_1',amount:850,currency:'jpy',destination:'acct_seller',destination_payment:'py_1',livemode:true,amount_reversed:0,reversed:false,source_transaction:null,metadata:{apple_settlement_id:expected.settlementId,payment_id:expected.paymentId},transfer_group:`apple_settlement_${expected.settlementId}`},'acct_platform'),
 destinationPayment:envelope({object:'charge',id:'py_1',source_transfer:'tr_1',balance_transaction:'txn_credit',amount:850,amount_captured:850,captured:true,paid:true,status:'succeeded',currency:'jpy',livemode:true,amount_refunded:0,refunded:false,disputed:false,failure_balance_transaction:null,failure_code:null,failure_message:null},'acct_seller'),
 payout:envelope({object:'payout',id:'po_1',amount:4000,currency:'jpy',livemode:true,destination:'ba_1',automatic:true,method:'standard',reconciliation_status:'completed',type:'bank_account',status:'paid',failure_balance_transaction:null,failure_code:null,failure_message:null,reversed_by:null,original_payout:null},'acct_seller'),
 payoutTransactions:{...envelope({object:'list',has_more:false,data:[{object:'balance_transaction',id:'txn_credit',source:'py_1',amount:850,fee:30,net:820,currency:'jpy',status:'available'},{object:'balance_transaction',id:'txn_other',source:'ch_other',amount:3180,fee:0,net:3180,currency:'jpy',status:'available'}]},'acct_seller'),context:{...envelope({},'acct_seller').context,payoutId:'po_1',paginationComplete:true}},
 };
}
test('verified membership in paid aggregate payout never asserts bank receipt or settlement',()=>{const f=fixture(),r=verify(f);assert.equal(r.assignmentVerified,true);assert.equal(r.stripePayoutPaid,true);assert.equal(r.creditAmountJpy,850);assert.equal(r.creditFeeJpy,30);assert.equal(r.creditNetJpy,820);assert.equal(r.payoutAmountJpy,4000);assert.equal(r.bankReceipt,'unverified');assert.equal(r.bankReceiptVerified,false);assert.equal(r.settlementComplete,false);});
test('aggregate payout can be smaller than credit due to other batch entries without assigning a bank share',()=>{const f=fixture();f.payout.data.amount=500;assert.equal(verify(f).payoutAmountJpy,500);assert.equal('bankShareJpy' in verify(f),false);});
const invalids={
 'missing explicit freshness policy':f=>delete f.maxAgeMs,
 'stale server retrieval':f=>f.transfer.context.retrievedAtMs=800,
 'future timestamp':f=>f.payout.context.retrievedAtMs=1200,
 'client provenance':f=>f.transfer.context.source='client',
 'wrong platform account':f=>f.transfer.context.accountId='acct_other',
 'wrong connected account':f=>f.destinationPayment.context.accountId='acct_other',
 'wrong payout list account':f=>f.payoutTransactions.context.accountId='acct_other',
 'mixed test data':f=>f.destinationPayment.data.livemode=false,
 'wrong transfer destination':f=>f.transfer.data.destination='acct_other',
 'different Apple allocation':f=>f.transfer.data.metadata.payment_id='other',
 'partial transfer reversal':f=>f.transfer.data.amount_reversed=1,
 'full transfer reversal':f=>{f.transfer.data.amount_reversed=850;f.transfer.data.reversed=true},
 'source-funded Stripe charge instead of Apple balance transfer':f=>f.transfer.data.source_transaction='ch_1',
 'wrong destination payment':f=>f.destinationPayment.data.id='py_other',
 'wrong source transfer':f=>f.destinationPayment.data.source_transfer='tr_other',
 'refunded credit':f=>f.destinationPayment.data.amount_refunded=1,
 'disputed credit':f=>f.destinationPayment.data.disputed=true,
 'manual payout':f=>f.payout.data.automatic=false,
 'instant payout':f=>f.payout.data.method='instant',
 'incomplete reconciliation':f=>f.payout.data.reconciliation_status='in_progress',
 'unsupported reconciliation':f=>f.payout.data.reconciliation_status='not_applicable',
 'failed payout':f=>f.payout.data.status='failed',
 'payout failure evidence despite paid status':f=>f.payout.data.failure_balance_transaction='txn_failure',
 'payout reversed':f=>f.payout.data.reversed_by='po_reverse',
 'wrong bank destination':f=>f.payout.data.destination='ba_other',
 'wrong currency':f=>f.payout.data.currency='usd',
 'has more pages':f=>f.payoutTransactions.data.has_more=true,
 'no complete pagination attestation':f=>delete f.payoutTransactions.context.paginationComplete,
 'wrong filter payout':f=>f.payoutTransactions.context.payoutId='po_other',
 'credit absent from payout':f=>f.payoutTransactions.data.data.shift(),
 'wrong credit source':f=>f.payoutTransactions.data.data[0].source='py_other',
 'wrong credit amount':f=>f.payoutTransactions.data.data[0].amount=900,
 'invalid fee arithmetic':f=>f.payoutTransactions.data.data[0].net=850,
 'pending credit':f=>f.payoutTransactions.data.data[0].status='pending',
 'duplicated pagination row':f=>f.payoutTransactions.data.data.push({...f.payoutTransactions.data.data[0]}),
};
for(const [name,mutate] of Object.entries(invalids))test(`rejects ${name}`,()=>{const f=fixture();mutate(f);assert.throws(()=>verify(f));});
test('expanded Stripe object IDs are accepted without altering identity',()=>{const f=fixture();f.transfer.data.destination={id:'acct_seller'};f.transfer.data.destination_payment={id:'py_1'};f.destinationPayment.data.source_transfer={id:'tr_1'};f.destinationPayment.data.balance_transaction={id:'txn_credit'};f.payout.data.destination={id:'ba_1'};f.payoutTransactions.data.data[0].source={id:'py_1'};assert.equal(verify(f).assignmentVerified,true)});

function noFeeFixture(){const f=fixture();Object.assign(f.payoutTransactions.data.data[0],{fee:0,net:850});f.payout.data.amount=4030;return f;}
test('only complete positive no-fee matching batch supports narrow settlement predicate',()=>{const r=verify(noFeeFixture());assert.equal(r.batchAllPositiveNoFees,true);assert.equal(r.batchNetTotalJpy,4030);assert.equal(r.batchMatchesPayout,true);assert.equal(r.settlementComplete,false)});
for(const [name,mutate] of Object.entries({
 'mixed debit':f=>Object.assign(f.payoutTransactions.data.data[1],{amount:-350,fee:0,net:-350}),
 'other credit fee':f=>Object.assign(f.payoutTransactions.data.data[1],{fee:10,net:3170}),
 'unknown batch arithmetic':f=>delete f.payoutTransactions.data.data[1].net,
 'pending other credit':f=>f.payoutTransactions.data.data[1].status='pending',
 'unsafe aggregate':f=>Object.assign(f.payoutTransactions.data.data[1],{amount:Number.MAX_SAFE_INTEGER,net:Number.MAX_SAFE_INTEGER}),
 'unexplained payout total':f=>f.payout.data.amount=500
}))test('batch settlement remains held: '+name,()=>{const f=noFeeFixture();mutate(f);const r=verify(f);assert.equal(r.assignmentVerified,true);assert.equal(r.batchAllPositiveNoFees&&r.batchMatchesPayout,false);assert.equal(r.settlementComplete,false)});
