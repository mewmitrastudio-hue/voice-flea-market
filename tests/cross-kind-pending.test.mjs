import {paymentBehaviorContext} from './fixtures/payment-behavior-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function harness(kind){
 const notices=[];const pending={transactions:[],purchaseBlocked:true,approvalPending:false,blockingKind:kind};
 const context=paymentBehaviorContext({setTimeout,clearTimeout,currentUser:{id:'buyer'},voicePurchaseBusy:false,voicePurchasePhase:null,voicePurchaseQuote:null,voicePurchaseRequest:0,isNativeBoost:()=>true,showVoicePurchase(){},voicePurchaseNotice:t=>notices.push(t),nativeBoost:async()=>({plugin:{pendingTransactions:async()=>pending}}),voicePreparationWait:fn=>fn(),voiceIapApi(){throw Error('must not verify absent purchase')},alert(){throw Error('unexpected alert')}});
 vm.runInContext(html.slice(html.indexOf('async function reconcileVoicePurchases(){'),html.indexOf('</script>',html.indexOf('async function reconcileVoicePurchases(){'))),context);
 return {context,notices};
}
test('voice recovery routes a pending boost to its actual recovery screen rather than claiming nothing pending',async()=>{
 const s=harness('boost');await s.context.reconcileVoicePurchases();
 assert.match(s.notices.at(-1),/出品ブースト/);assert.doesNotMatch(s.notices.at(-1),/未反映の購入はありません/);
});
test('native pending metadata identifies the journal type before filtering transactions',()=>{
 const native=fs.readFileSync(new URL('../BoostPlugin.swift',import.meta.url),'utf8');
 assert.match(native,/"blockingKind":/);
 const pending=native.slice(native.indexOf('@objc func pendingTransactions'),native.indexOf('@objc func finish'));
 assert.ok(pending.indexOf('matchingTransaction = true') < pending.indexOf('if let kind ='));
});
test('boost recovery directs a pending voice purchase to the voice screen without purchase or finish',async()=>{
 const notices=[],pending={transactions:[],purchaseBlocked:true,approvalPending:false,blockingKind:'voice'};
 const context=paymentBehaviorContext({boostBusy:false,boostReady:true,boostRequest:0,boostHistoryReady:true,currentUser:{id:'buyer'},boostListingChanged(){},boostNotice:t=>notices.push(t),isNativeBoost:()=>true,boostRead:fn=>fn(),nativeBoost:async()=>({plugin:{pendingTransactions:async()=>pending}}),boostApi(){throw Error('no transaction to verify')},document:{getElementById:()=>({value:'listing'})},openBoostPreview:async()=>{}});
 vm.runInContext(html.slice(html.indexOf('async function reconcileBoostPurchases(){'),html.indexOf('function closeBoostPreview(){')),context);
 await context.reconcileBoostPurchases();assert.match(notices.at(-1),/声を探す・購入/);assert.match(notices.at(-1),/音声購入の反映/);assert.doesNotMatch(notices.at(-1),/反映待ちの購入はありません/);
});
