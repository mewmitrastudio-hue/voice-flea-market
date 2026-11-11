import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const path=process.env.HTML_PATH||new URL('../index.html',import.meta.url);
const html=readFileSync(path,'utf8');
const start=html.includes('let deliveryConfirmationTarget=null;')?'let deliveryConfirmationTarget=null;':'function openDeliveryConfirm(){';
const source=html.slice(html.indexOf(start),html.indexOf('async function loadMessageBadge(){',html.indexOf(start)));
function fixture(){
 const calls=[];let resolve;
 const trade={id:'trade-A',buyer_id:'buyer-A',payment_id:'payment-A',delivery_path:'A/file.wav',delivered_at:'2026-11-11',delivery_status:'submitted'};
 const el={classList:{add(){},remove(){}},setAttribute(){}};
 const c=vm.createContext({currentUser:{id:'buyer-A'},currentConversationId:'trade-A',currentConversation:{...trade},authReloadPending:false,document:{getElementById:()=>el},info(){},loadDeliveries:async()=>{},loadChatMessages:async()=>{},loadTradeInfoPanel:async()=>{},loadReviewPanel:async()=>{},loadHome(){},loadNotificationBadge(){},sb:{functions:{invoke(name,args){calls.push({name,args});return new Promise(r=>resolve=r);}}}});
 vm.runInContext(source,c);
 return {c,calls,trade,finish(){resolve({data:{success:true,conversation:{...trade,delivery_status:'accepted'}}});}};
}
test('confirmation opened for A cannot accept B after asynchronous conversation switch',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.currentConversationId='trade-B';f.c.currentConversation={...f.trade,id:'trade-B',payment_id:'payment-B'};const pending=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await pending;});
test('confirmation cannot accept replacement payment',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.currentConversation.payment_id='replacement';const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('confirmation cannot accept replacement delivery',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.currentConversation.delivery_path='new/file.wav';const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('closed confirmation cannot be replayed',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.closeDeliveryConfirm();const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('same confirmed trade still invokes current accept-delivery once on double click',async()=>{const f=fixture();f.c.openDeliveryConfirm();const p=f.c.acceptDeliveryConfirmed();await f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'accept-delivery');assert.equal(f.calls[0].args.body.conversationId,'trade-A');f.finish();await p;assert.equal(f.c.currentConversation.delivery_status,'accepted');});
test('account change after modal opened causes no receipt call',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.currentUser={id:'buyer-B'};f.c.currentConversation={...f.trade,buyer_id:'buyer-B'};const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('inconsistent conversation ID cannot open receipt confirmation',async()=>{const f=fixture();f.c.currentConversation.id='different';f.c.openDeliveryConfirm();const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('changed delivery state requires a fresh confirmation',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.currentConversation.delivery_status='accepted';const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,0);await p;});
test('reopened modal replaces canceled target and accepts its new trade',async()=>{const f=fixture();f.c.openDeliveryConfirm();f.c.closeDeliveryConfirm();f.c.currentConversationId='trade-B';f.c.currentConversation={...f.trade,id:'trade-B',payment_id:'payment-B'};f.c.openDeliveryConfirm();const p=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,1);assert.equal(f.calls[0].args.body.conversationId,'trade-B');f.finish();await p;});
test('old in-flight completion does not clear a new modal target',async()=>{const f=fixture();f.c.openDeliveryConfirm();const p=f.c.acceptDeliveryConfirmed();f.c.currentConversationId='trade-B';f.c.currentConversation={...f.trade,id:'trade-B',payment_id:'payment-B'};f.c.openDeliveryConfirm();f.finish();await p;const next=f.c.acceptDeliveryConfirmed();assert.equal(f.calls.length,2);assert.equal(f.calls[1].args.body.conversationId,'trade-B');f.finish();await next;});
