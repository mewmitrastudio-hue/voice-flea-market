import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('const checkoutInFlight='),html.indexOf('function checkoutReturnPrefix('));
function setup(stage){
 const pending=Promise.withResolvers(),saved=new Map(),redirects=[],errors=[],remembered=[],bodies=[];
 const session={data:{session:{access_token:'test-only',user:{id:'buyer'}}}};
 const result={sessionId:'cs_test_ready',url:'https://checkout.stripe.com/c/pay/test'};
 const response={ok:true,text:()=>stage==='body'?pending.promise:Promise.resolve(JSON.stringify(result))};
 const ctx={setTimeout:(f,ms)=>setTimeout(f,Math.min(ms,10)),clearTimeout,Set,Promise,Error,URL,console:{error(){}},
  currentUser:{id:'buyer'},pageNavigationRequest:1,crypto:{randomUUID:()=> 'stable-attempt'},
  window:{VOICE_FLEA_CONFIG:{SUPABASE_URL:'https://example.test',SUPABASE_PUBLISHABLE_KEY:'test'},location:{assign:u=>redirects.push(u)}},
  sb:{auth:{getSession:()=>stage==='session'?pending.promise:Promise.resolve(session)}},
  safeLocalStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
  fetch:async(_,o)=>{bodies.push(JSON.parse(o.body));return stage==='fetch'?pending.promise:response;},
  showCheckoutError:e=>errors.push(e.message),alert:m=>errors.push(m),rememberCheckoutReturn:(...a)=>remembered.push(a)
 };
 vm.createContext(ctx);vm.runInContext(code,ctx);
 return {ctx,pending,saved,redirects,errors,remembered,bodies,session,response,result};
}
for(const stage of ['session','fetch','body'])test(`stalled ${stage} recovers UI and preserves attempt without late redirect`,async()=>{
 const f=setup(stage),button={textContent:'購入する',disabled:false};
 await f.ctx.startStripeCheckout('listing',button);
 assert.equal(button.disabled,false);assert.equal(button.textContent,'購入する');
 assert.match(f.errors[0],/時間内/);assert.equal(f.saved.get('vf_checkout_attempt_buyer:listing'),'stable-attempt');
 assert.equal(vm.runInContext('checkoutInFlight.size',f.ctx),0);
 f.pending.resolve(stage==='session'?f.session:stage==='fetch'?f.response:JSON.stringify(f.result));
 await new Promise(r=>setTimeout(r,2));assert.equal(f.redirects.length,0);assert.equal(f.remembered.length,0);
});
test('successful retry uses original attempt and opens validated exact Checkout',async()=>{
 const f=setup('fetch');await f.ctx.startStripeCheckout('listing');
 f.pending.resolve(f.response);await f.ctx.startStripeCheckout('listing');
 assert.equal(f.bodies.length,2);assert.equal(f.bodies[0].attemptId,f.bodies[1].attemptId);
 assert.deepEqual(f.redirects,[f.result.url]);assert.equal(f.saved.size,0);assert.equal(f.remembered.length,1);
});
