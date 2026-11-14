import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fixture(){
 const reads=[], redirects=[], messages=[], saved=new Map();
 const checkout=Promise.withResolvers(),renewal=Promise.withResolvers();
 const c={setTimeout,clearTimeout,
  currentUser:{id:'buyer'},currentConversationId:'trade',pageNavigationRequest:0,
  authorizationActionStates:new Map([['trade',{canRenew:true,amountJpy:1000}]]),
  sb:{auth:{getSession:async()=>{reads.push('checkout');return checkout.promise;}},
   functions:{invoke:async()=>{reads.push('renewal');return renewal.promise;}}},
  alert:m=>messages.push(m),info:(_,m)=>messages.push(m),confirm:()=>true,financeYen:()=> '1,000円',
  window:{location:{assign:url=>redirects.push(url)}},
  safeLocalStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
  crypto:{randomUUID:()=> 'attempt'},URL,
 };
 vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('const checkoutInFlight='),html.indexOf('async function reconcilePendingPurchase('))+
  html.slice(html.indexOf('async function renewTradeAuthorization('),html.indexOf('async function loadDeliveries(')),c);
 return {c,reads,redirects,messages,saved,checkout,renewal};
}

test('only one Web payment preparation per buyer can run in the same tab',async()=>{
 const f=fixture();
 const first=f.c.startStripeCheckout('listing-a');
 await f.c.startStripeCheckout('listing-b');
 await f.c.renewTradeAuthorization();
 assert.deepEqual(f.reads,['checkout']);
 assert.match(f.messages.at(-1),/別のお支払いを準備中/);
 f.c.pageNavigationRequest++;
 f.checkout.resolve({data:{session:null}});
 await first;
 const next=f.c.renewTradeAuthorization();
 assert.deepEqual(f.reads,['checkout','renewal']);
 f.renewal.resolve({data:{success:true,listingId:'listing-a',sessionId:'cs_test_renew',url:'https://checkout.stripe.com/c/pay/test'}});
 await next;
 assert.deepEqual(f.redirects,['https://checkout.stripe.com/c/pay/test']);
});

test('renewal keeps the exact session after navigation without opening old Checkout',async()=>{
 const f=fixture();
 const first=f.c.renewTradeAuthorization();
 await f.c.startStripeCheckout('listing-b');
 assert.deepEqual(f.reads,['renewal']);
 f.c.currentConversationId='another-trade';
 f.renewal.resolve({data:{success:true,listingId:'listing-a',sessionId:'cs_test_renew',url:'https://checkout.stripe.com/c/pay/test'}});
 await first;
 assert.equal(JSON.parse(f.saved.get('vf_checkout_return_buyer:cs_test_renew')).checkoutSessionId,'cs_test_renew');
 assert.deepEqual(f.redirects,[]);
});
