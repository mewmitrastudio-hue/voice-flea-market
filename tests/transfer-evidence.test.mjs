import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTransferEvidence} from '../supabase/functions/_shared/transfer-evidence.mjs';
const expected={id:'tr_unit',destination:'acct_seller',livemode:true,amount:541,currency:'jpy',sourceTransaction:null};
const transfer={id:'tr_unit',object:'transfer',destination:'acct_seller',livemode:true,amount:541,currency:'jpy',source_transaction:null,amount_reversed:0,reversed:false};
test('Connect balance transfers are distinguished from bank payouts and partial/full reversals',()=>{
 assert.equal(verifyTransferEvidence(transfer,expected).bankPayout,'unverified');
 const partial=verifyTransferEvidence({...transfer,amount_reversed:100},expected);
 assert.equal(partial.state,'partially_reversed');assert.equal(partial.remainingJpy,441);
 assert.equal(verifyTransferEvidence({...transfer,amount_reversed:541,reversed:true},expected).state,'reversed');
 assert.equal(verifyTransferEvidence({...transfer,destination:{id:'acct_seller'}},expected).state,'transferred');
});
test('missing, foreign, test-mode, incorrectly funded and internally inconsistent evidence fails closed',()=>{
 for(const patch of [{object:'payout'},{id:'tr_other'},{destination:'acct_other'},{livemode:false},{amount:542},{currency:'usd'},
  {source_transaction:'ch_other'},{source_transaction:undefined},{amount_reversed:undefined},{amount_reversed:-1},
  {amount_reversed:542},{amount_reversed:0.5},{reversed:true},{amount_reversed:541,reversed:false}]){
  assert.throws(()=>verifyTransferEvidence({...transfer,...patch},expected),/mismatch/);
 }
 for(const patch of [{livemode:undefined},{amount:0},{amount:'541'},{sourceTransaction:undefined},{sourceTransaction:'apple123'}]){
  assert.throws(()=>verifyTransferEvidence(transfer,{...expected,...patch}),/mismatch/);
 }
});
