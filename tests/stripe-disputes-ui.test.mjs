import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let stripeDisputeNoticeRequest=0;'),html.indexOf('async function refreshAppleRefundReviewNotice(){'));
function setup(response,mode='buyer'){
 const target={textContent:''},overlay={classList:{contains:()=>true}};
 const c=vm.createContext({currentUser:{id:'owner'},activeFinanceMode:mode,document:{getElementById:id=>id==='financeOverlay'?overlay:target},sb:{rpc:async n=>{assert.equal(n,'stripe_dispute_review_status');return typeof response==='function'?response():response}}});
 vm.runInContext(source,c);return {c,target,overlay};
}
test('buyer/seller explain distinct dispute consequences without revoking content or claiming cash recovery',async()=>{
 for(const mode of ['buyer','seller']){const x=setup({data:{reviewRequired:true,count:1,rows:[{}]}},mode);await x.c.refreshStripeDisputeReviewNotice();assert.match(x.target.textContent,/閲覧権利は変更していません/);assert.match(x.target.textContent,mode==='buyer'?/返金完了を意味しません/:/資金回収が済んだ意味ではありません/);}
});
test('unavailable/inconsistent dispute status never claims there are no records',async()=>{
 for(const response of [{error:true},{data:{reviewRequired:false,count:2,rows:[]}},{data:{reviewRequired:true,count:-1,rows:[]}}]){const x=setup(response);await x.c.refreshStripeDisputeReviewNotice();assert.match(x.target.textContent,/確認できません/);}
});
test('account or mode change and panel close discard stale responses',async()=>{
 for(const change of [x=>x.c.currentUser={id:'other'},x=>x.c.activeFinanceMode='seller',x=>x.overlay.classList.contains=()=>false]){
 let finish;const x=setup(()=>new Promise(r=>finish=r));const p=x.c.refreshStripeDisputeReviewNotice();change(x);finish({data:{reviewRequired:true,count:99,rows:[]}});await p;assert.doesNotMatch(x.target.textContent,/99件/);}
});
test('operator queue labels known receipt references separately from Stripe observations and highlights conflicts',async()=>{
 const src=html.slice(html.indexOf('let stripeDisputeQueueRequest=0;'),html.indexOf('async function loadAdminPaymentReceipts('));
 const box={textContent:'',innerHTML:''};
 const c=vm.createContext({currentUser:{id:'operator'},isVoiceFleaAdmin:()=>true,document:{getElementById:()=>box},esc:x=>String(x),financeYen:x=>`${x}円`,formatJpDateTime:x=>x,
 sb:{rpc:async(n,a)=>{assert.equal(n,'stripe_dispute_review_status');assert.equal(a.operator_view,true);return {data:{count:1,rows:[{disputeId:'dp_test',paymentId:'p_test',environment:'Production',status:'won',disputedAmountJpy:500,transferId:'tr_conflicting',knownTransferIds:['tr_known'],transferEvidenceConflict:true}]}};}}});
 vm.runInContext(src,c);await c.loadStripeDisputeQueue();
 assert.match(box.innerHTML,/Stripe観測の送金ID：tr_conflicting/);assert.match(box.innerHTML,/受取確定時の既知送金ID：tr_known/);assert.match(box.innerHTML,/送金IDの不一致/);assert.match(box.innerHTML,/回収・手数料：未確認/);
});
