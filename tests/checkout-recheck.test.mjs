import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

function fixture(){
 const button={},message={},calls=[];
 const overlay={classList:{add(){},remove(){},contains:()=>false},setAttribute(k,v){this[k]=v;}};
 const close={},source={isConnected:true};
 const nodes={checkoutRecheckButton:button,checkoutErrorClose:close,checkoutErrorMessage:message,checkoutErrorOverlay:overlay};
 const result=Promise.withResolvers();
 const c={currentUser:{id:'buyer'},pageNavigationRequest:1,
  document:{activeElement:source,getElementById:id=>nodes[id],body:{classList:{add(){},remove(){}}}},
  validCheckoutSessionId:id=>/^cs_test_/.test(id),
  reconcilePendingPurchase:(...args)=>{calls.push(args);return result.promise;},
 };
 for(const element of [button,close,source])element.focus=()=>{c.document.activeElement=element;};
 vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('let checkoutRecheckTarget='),html.indexOf('// Checkout and reauthorization share')),c);
 return {c,result,button,close,source,message,overlay,calls};
}

test('a pending checkout rechecks only its original session and ignores duplicate taps',async()=>{
 const f=fixture();
 f.c.showPendingCheckout('cs_test_original');
 const first=f.c.recheckCheckoutStatus();
 await f.c.recheckCheckoutStatus();
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].slice(0,2),[1,'cs_test_original']);
 assert.equal(f.button.disabled,true);
 f.result.resolve({id:'trade'});
 await first;
 assert.equal(f.overlay['aria-hidden'],'true');
});

test('unconfirmed recheck leaves retry available and account changes invalidate its presentation',async()=>{
 const f=fixture();
 f.c.showPendingCheckout('cs_test_original');
 const first=f.c.recheckCheckoutStatus();
 f.result.resolve(null);
 await first;
 assert.equal(f.button.disabled,false);
 assert.match(f.message.textContent,/再購入せず/);
 f.c.currentUser={id:'other'};
 assert.equal(f.calls[0][2](),false);
 await f.c.recheckCheckoutStatus();
 assert.equal(f.calls.length,1);
});

test('Web buyer history opens a recheck for the current account’s exact pending payment',()=>{
 const opened=[],lookups=[];
 const button={hidden:false};
 const c={activeFinanceMode:'buyer',currentUser:{id:'buyer'},authReloadPending:false,window:{},
  document:{getElementById:id=>id==='financeOverlay'?{classList:{contains:()=>true}}:button},
  findCheckoutReturn:owner=>{lookups.push(owner);return {pending:{checkoutSessionId:'cs_test_original'}};},
  closeFinanceCenter:()=>opened.push('close history'),
  showPendingCheckout:session=>opened.push(session),
 };
 vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('function pendingCheckoutFromBuyerHistory('),html.indexOf('async function openFinanceCenter(')),c);
 c.openPendingCheckoutFromHistory();
 assert.deepEqual(lookups,['buyer']);
 assert.deepEqual(opened,['close history','cs_test_original']);
 for(const state of [{activeFinanceMode:'seller'},{activeFinanceMode:'buyer',authReloadPending:true},
  {authReloadPending:false,window:{Capacitor:{isNativePlatform:()=>true}}}]){
  Object.assign(c,state);
  c.openPendingCheckoutFromHistory();
  assert.equal(button.hidden,true);
 }
 assert.equal(lookups.length,1);
 assert.equal(opened.length,2);
});

test('checkout dialog keeps keyboard navigation inside and Escape restores the opener',()=>{
 const f=fixture();
 f.c.showPendingCheckout('cs_test_original');
 assert.equal(f.c.document.activeElement,f.button);
 const press=key=>f.c.handleCheckoutDialogKey({key,preventDefault(){},stopPropagation(){}});
 press('Tab');
 assert.equal(f.c.document.activeElement,f.close);
 press('Tab');
 assert.equal(f.c.document.activeElement,f.button);
 press('Escape');
 assert.equal(f.c.document.activeElement,f.source);
 assert.equal(f.overlay['aria-hidden'],'true');
});
