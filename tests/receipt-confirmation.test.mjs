import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const handler=html.slice(html.indexOf('const acceptingDeliveries='),html.indexOf('async function loadMessageBadge(){'));

function receiptContext(invoke) {
 const notices=[];
 let completed=0;
 const context={
   deliveryConfirmationTarget:{conversationId:'trade',userId:'buyer',paymentId:'payment',deliveryStatus:'submitted'},currentUser:{id:'buyer'},
   currentConversationId:'trade',
   currentConversation:{id:'trade',buyer_id:'buyer',payment_id:'payment',delivery_status:'submitted'},
   sb:{functions:{invoke}},
   Response,
   closeDeliveryConfirm(){},
   info:(...args)=>notices.push(args),
   loadDeliveries(){},
   loadChatMessages(){},
   loadTradeInfoPanel(){},
   loadReviewPanel(){},
   showReceiptSuccess(){completed++;},
   loadHome(){},
   loadNotificationBadge(){},
 };
 runInNewContext(handler,context);
 return {context,notices,completed:()=>completed};
}

test('receipt waits for the server to confirm the matching trade',async()=>{
 let finish;
 const {context,completed}=receiptContext((name,{body})=>{
   assert.equal(name,'accept-delivery');
   assert.equal(body.conversationId,'trade');
   return new Promise(resolve=>{finish=resolve;});
 });
 const result=context.acceptDeliveryConfirmed();
 assert.equal(context.currentConversation.delivery_status,'submitted');
 assert.equal(completed(),0);
 finish({data:{success:true,conversation:{id:'trade',buyer_id:'buyer',payment_id:'payment',delivery_status:'accepted'}}});
 await result;
 assert.equal(context.currentConversation.delivery_status,'accepted');
 assert.equal(completed(),1);
});

test('receipt failure keeps the delivery pending and displays the server message',async()=>{
 const {context,notices,completed}=receiptContext(async()=>({
   error:{context:Response.json({error:'再購入せず運営へお問い合わせください。'},{status:409})},
 }));
 await context.acceptDeliveryConfirmed();
 assert.equal(context.currentConversation.delivery_status,'submitted');
 assert.equal(completed(),0);
 assert.deepEqual(notices.at(-1),['chatMsg','再購入せず運営へお問い合わせください。','err']);
});

test('receipt results from a previous account do not change the current screen',async()=>{
 let finish;
 const {context,completed}=receiptContext(()=>new Promise(resolve=>{finish=resolve;}));
 const result=context.acceptDeliveryConfirmed();
 context.currentUser={id:'another-buyer'};
 finish({data:{success:true,conversation:{id:'trade',buyer_id:'buyer',payment_id:'payment',delivery_status:'accepted'}}});
 await result;
 assert.equal(context.currentConversation.delivery_status,'submitted');
 assert.equal(completed(),0);
});
