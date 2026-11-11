import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

function fixture(){
 const button={},message={},calls=[];
 const overlay={classList:{add(){},remove(){}},setAttribute(k,v){this[k]=v;}};
 const nodes={checkoutRecheckButton:button,checkoutErrorMessage:message,checkoutErrorOverlay:overlay};
 const result=Promise.withResolvers();
 const c={currentUser:{id:'buyer'},pageNavigationRequest:1,
  document:{getElementById:id=>nodes[id],body:{classList:{add(){},remove(){}}}},
  validCheckoutSessionId:id=>/^cs_test_/.test(id),
  reconcilePendingPurchase:(...args)=>{calls.push(args);return result.promise;},
 };
 vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('let checkoutRecheckTarget='),html.indexOf('// Checkout and reauthorization share')),c);
 return {c,result,button,message,overlay,calls};
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
