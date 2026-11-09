import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fixture(){
 let resolve;const calls=[],notices=[];
 const current={id:'trade',buyer_id:'buyer',seller_id:'seller',payment_id:'payment',delivery_status:'submitted'};
 const c={Set,Error,currentConversation:current,currentUser:{id:'buyer'},currentConversationId:'trade',closeDeliveryConfirm(){},
 info:(id,text)=>notices.push(text),loadDeliveries:async()=>{},loadChatMessages:async()=>{},loadTradeInfoPanel:async()=>{},loadReviewPanel:async()=>{},showReceiptSuccess(){calls.push('success')},loadHome(){},loadNotificationBadge(){},
 sb:{functions:{invoke:async(name,args)=>{calls.push({name,args});return new Promise(r=>resolve=r);}}}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const acceptingDeliveries='),html.indexOf('async function loadMessageBadge()')),c);
 return {c,calls,notices,resolve:x=>resolve(x),current};
}
test('receipt UI uses the server endpoint once and waits for durable confirmation before showing success',async()=>{
 const f=fixture(),run=f.c.acceptDeliveryConfirmed();await f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'accept-delivery');assert.equal(f.calls[0].args.body.conversationId,'trade');
 assert.equal(f.c.currentConversation.delivery_status,'submitted');f.resolve({data:{success:true,conversation:{...f.current,delivery_status:'accepted'}}});await run;assert.equal(f.c.currentConversation.delivery_status,'accepted');assert.equal(f.calls.at(-1),'success');
});
test('server errors release the UI lock without inventing a receipt, and account changes discard private results',async()=>{
 const f=fixture(),run=f.c.acceptDeliveryConfirmed();f.resolve({error:{context:{json:async()=>({error:'与信期限を確認してください。'})}}});await run;
 assert.equal(f.c.currentConversation.delivery_status,'submitted');assert.equal(f.calls.includes('success'),false);assert.match(f.notices.at(-1),/与信期限/);
 const retry=f.c.acceptDeliveryConfirmed();f.c.currentUser={id:'other'};f.resolve({data:{success:true,conversation:{...f.current,delivery_status:'accepted'}}});await retry;assert.equal(f.c.currentConversation.delivery_status,'submitted');
});
