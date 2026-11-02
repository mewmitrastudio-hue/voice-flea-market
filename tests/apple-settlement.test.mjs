import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchAppleSettlement,reconcileAppleSettlement} from '../supabase/functions/_shared/apple-settlement.mjs';
const id='00000000-0000-4000-8000-000000000001',payment='00000000-0000-4000-8000-000000000002';
function setup(){
 const op={id,payment_id:payment,seller_id:'seller',platform_id:'acct_platform',destination:'acct_seller',amount_jpy:541,currency:'jpy',livemode:true,state:'prepared'};
 let creates=0,records=0,claims=0;
 const transfer={id:'tr_apple',object:'transfer',amount:541,currency:'jpy',destination:'acct_seller',livemode:true,source_transaction:null,amount_reversed:0,reversed:false,transfer_group:`apple_settlement_${id}`,metadata:{apple_settlement_id:id,payment_id:payment}};
 const stripe={accounts:{retrieve:async()=>({id:'acct_platform'})},balance:{retrieve:async()=>({object:'balance',livemode:true,available:[{currency:'jpy',amount:541}]})},transfers:{create:async(params,opts)=>{creates++;assert.equal(params.source_transaction,undefined);assert.equal(opts.idempotencyKey,`apple-settlement:${id}`);return {id:'tr_apple'};},retrieve:async()=>transfer}};
 const journal={load:async()=>({...op}),claim:async()=>{if(op.state!=='prepared')throw Error('claimed');op.state='dispatching';claims++;},record:async()=>{records++;op.state='transferred';}};
 const args={journal,stripe,recipient:async()=>op.destination,verifyApple:async()=>{},platformId:'acct_platform',enabled:true};
 return {op,transfer,stripe,journal,args,counts:()=>({creates,records,claims})};
}
test('Apple transfer uses frozen server allocation and fresh evidence, but never reports bank paid',async()=>{
 const x=setup();const result=await dispatchAppleSettlement(x.args);
 assert.equal(result.remainingJpy,541);assert.equal(result.bankPayout,'unverified');assert.equal(result.settlement,'bank_payout_unverified');
 assert.deepEqual(x.counts(),{creates:1,records:1,claims:1});
 await assert.rejects(dispatchAppleSettlement(x.args),/reconciliation_required/);assert.equal(x.counts().creates,1);
});
test('disabled, changed platform/recipient, revoked Apple payment and insufficient balance do not claim or send',async()=>{
 for(const kind of ['disabled','platform','recipient','apple','balance','testmode']){
  const x=setup();
  if(kind==='disabled')x.args.enabled=false;
  if(kind==='platform')x.stripe.accounts.retrieve=async()=>({id:'acct_wrong'});
  if(kind==='recipient')x.args.recipient=async()=> 'acct_changed';
  if(kind==='apple')x.args.verifyApple=async()=>{throw Error('revoked');};
  if(kind==='balance')x.stripe.balance.retrieve=async()=>({object:'balance',livemode:true,available:[{currency:'jpy',amount:540}]});
  if(kind==='testmode')x.op.livemode=false;
  await assert.rejects(dispatchAppleSettlement(x.args));assert.deepEqual(x.counts(),{creates:0,records:0,claims:0});
 }
});
test('lost Stripe response and failed persistence stay claimed across retries, including expired idempotency windows',async()=>{
 for(const kind of ['lost','persistence']){
  const x=setup();
  if(kind==='lost'){const create=x.stripe.transfers.create;x.stripe.transfers.create=async(...args)=>{await create(...args);throw Error('timeout');};}
  else x.journal.record=async()=>{throw Error('DB unavailable');};
  await assert.rejects(dispatchAppleSettlement(x.args));assert.equal(x.op.state,'dispatching');
  await assert.rejects(dispatchAppleSettlement(x.args));assert.equal(x.counts().creates,1);
  x.journal.record=async()=>{x.op.state='transferred';};
  await reconcileAppleSettlement({op:x.op,transferId:'tr_apple',stripe:x.stripe,journal:x.journal});
  assert.equal(x.op.state,'transferred');assert.equal(x.counts().creates,1);
 }
});
test('simultaneous dispatch is claimed once; mismatched evidence never records success',async()=>{
 const x=setup();const results=await Promise.allSettled([dispatchAppleSettlement(x.args),dispatchAppleSettlement(x.args)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.counts().creates,1);
 for(const mutate of [t=>t.metadata.payment_id='other',t=>t.amount=542,t=>t.livemode=false,t=>t.destination='acct_other',t=>t.source_transaction='ch_other']){
  const y=setup();mutate(y.transfer);await assert.rejects(dispatchAppleSettlement(y.args));assert.equal(y.counts().records,0);assert.equal(y.op.state,'dispatching');
 }
});
