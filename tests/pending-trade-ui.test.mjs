import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const row={kind:'trade',item_id:'00000000-0000-4000-8000-000000000001',party:'buyer',conversation_id:'00000000-0000-4000-8000-000000000001',title:'<img src=x onerror=alert(1)>',action:'receipt_required',created_at:'2026-10-29T00:00:00Z',is_test:false};
const first={total:2,needsAction:1,waiting:1,rows:[row],hasMore:true};
function fixture(){
 const ids=['homePendingTrades','mePendingTrades','home','pendingTradeItems','pendingTradeMore','pendingTradeBadge','pendingTradeOverlay'];
 const nodes=new Map(ids.map(id=>{const classes=new Set();return [id,{innerHTML:'',textContent:'',hidden:true,disabled:false,classes,replaceChildren(){this.innerHTML='';},addEventListener(){},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),toggle(k,on){on?classes.add(k):classes.delete(k);}}}];}));
 const calls=[];
 const c={currentUser:{id:'buyer'},document:{getElementById:id=>nodes.get(id)},Map,Set,Date,Number,String,Error,
  esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),
  sb:{rpc:async(name,args)=>{calls.push({name,args});return {data:first};}}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const pendingTradeState='),html.indexOf('async function loadHome(){'))+'\nthis.state=pendingTradeState;',c);return {c,nodes,calls};
}
test('unfinished trades appear on home and profile with actionable labels; completed work clears notices and the menu count',async()=>{
 const {c,nodes}=fixture();await c.loadPendingTradeNotice();
 for(const id of ['homePendingTrades','mePendingTrades']){assert.equal(nodes.get(id).hidden,false);assert.match(nodes.get(id).innerHTML,/未完了の項目が2件/);assert.match(nodes.get(id).innerHTML,/受取確認が必要/);assert.ok(!nodes.get(id).innerHTML.includes('<img'));assert.match(nodes.get(id).innerHTML,/&lt;img/);}
 assert.equal(nodes.get('pendingTradeBadge').textContent,'2');assert.equal(nodes.get('home').classes.has('home-has-pending'),true);
 c.sb.rpc=async()=>({data:{total:0,needsAction:0,waiting:0,rows:[],hasMore:false}});await c.loadPendingTradeNotice();
 assert.equal(nodes.get('homePendingTrades').hidden,true);assert.equal(nodes.get('mePendingTrades').hidden,true);assert.equal(nodes.get('pendingTradeBadge').textContent,'');assert.equal(c.state.rows.length,0);
});
test('failed paging keeps visible work and retries the same cursor rather than reporting zero unfinished items',async()=>{
 const {c,nodes,calls}=fixture();await c.loadPendingTradeNotice();
 c.sb.rpc=async(name,args)=>{calls.push({name,args});return {error:true};};await c.loadPendingTradeNotice(true);await c.loadPendingTradeNotice(true);
 assert.equal(c.state.rows.length,1);assert.equal(nodes.get('homePendingTrades').hidden,false);assert.match(nodes.get('homePendingTrades').innerHTML,/前回確認した内容/);assert.deepEqual(calls[1].args,calls[2].args);
});
test('logout and account-switch responses cannot expose another accounts pending trades',async()=>{
 const {c,nodes}=fixture();let resolveOld,resolveNew;
 c.sb.rpc=()=>new Promise(r=>resolveOld=r);const old=c.loadPendingTradeNotice();
 c.resetPendingTradeNotice();c.currentUser={id:'other'};c.sb.rpc=()=>new Promise(r=>resolveNew=r);const current=c.loadPendingTradeNotice();
 resolveOld({data:first});await old;assert.equal(c.state.rows.length,0);assert.equal(nodes.get('homePendingTrades').hidden,true);
 resolveNew({data:{total:0,needsAction:0,waiting:0,rows:[],hasMore:false}});await current;assert.equal(c.state.owner,'other');assert.equal(c.state.rows.length,0);
});

test('an unlinked payment routes its owner to finance without trying to open a missing chat',async()=>{
 const {c}=fixture();const receipt={...row,kind:'payment',conversation_id:null,action:'payment_check',party:'seller'};
 c.sb.rpc=async()=>({data:{total:1,needsAction:1,waiting:0,rows:[receipt],hasMore:false}});await c.loadPendingTradeNotice();
 const opened=[];c.closeMainMenu=()=>{};c.openFinanceCenter=async party=>opened.push(party);c.openConversation=()=>assert.fail('missing conversation must not open');
 await c.openPendingTrade('payment',receipt.item_id);assert.deepEqual(opened,['seller']);
});
