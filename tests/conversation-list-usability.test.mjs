import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('let conversationListRequest='),html.indexOf('function hidePartnerConversations('));
function deferred(){let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b}),resolve,reject}}
function setup(reply){
 const calls=[];let page='messages';
 const c=vm.createContext({currentUser:{id:'buyer'},conversationOpenRequest:0,conversationList:{style:{},innerHTML:''},chatBox:{classList:{remove(){}}},msgBadge:{classList:{remove(){}}},document:{querySelector:()=>({id:page})},setShellMode(){},esc:String,inlineText:String,isConversationHidden:()=>false,avatarMarkup:()=>'',formatJpDateTime:String,seenKey:String,safeLocalStorage:{getItem:()=>null},loadMessageBadge(){},sb:{from(table){let fields,filters={};const q={select(s){fields=s;return q},or(){return q},order(){return q},in(){return q},eq(k,v){filters[k]=v;return q},neq(){return q},gt(){return q},limit(){return q},then(resolve,reject){calls.push(table);return Promise.resolve().then(()=>reply({table,fields,filters})).then(resolve,reject)}};return q}}});
 vm.runInContext(source,c);return {c,calls,page:id=>page=id};
}
const conv=(id,partner,created_at)=>({id,buyer_id:'buyer',seller_id:partner,created_at});
test('conversations sort by recent message, not relationship creation',async()=>{
 const {c}=setup(({table,fields,filters})=>table==='conversations'?{data:[conv('new','newPartner','2026-11-03'),conv('old','oldPartner','2026-10-01')]}:table==='profiles'?{data:[{id:'newPartner',display_name:'New relationship'},{id:'oldPartner',display_name:'Recent reply'}]}:fields==='*'?{count:0}:{data:[{body:'reply',created_at:filters.conversation_id==='old'?'2026-11-04':'2026-11-03'}]});
 await c.loadConversations();assert.ok(c.conversationList.innerHTML.indexOf('Recent reply')<c.conversationList.innerHTML.indexOf('New relationship'));assert.match(c.conversationList.innerHTML,/tabindex="0" role="link"/);
});
test('newer list result wins over a slow old result',async()=>{const old=deferred();let n=0;const {c}=setup(()=>++n===1?old.promise:{data:[]});const first=c.loadConversations();await Promise.resolve();await Promise.resolve();await c.loadConversations();old.resolve({error:Error('old failure')});await first;assert.match(c.conversationList.innerHTML,/まだメッセージ/)});
for(const change of ['account','page','conversation'])test(`${change} switch suppresses pending response`,async()=>{const d=deferred();const s=setup(()=>d.promise);const pending=s.c.loadConversations();if(change==='account')s.c.currentUser={id:'other'};if(change==='page')s.page('home');if(change==='conversation')s.c.conversationOpenRequest++;s.c.conversationList.innerHTML='new screen';d.resolve({error:Error('offline')});await pending;assert.equal(s.c.conversationList.innerHTML,'new screen')});
test('offline request provides a retry instead of uncaught failure',async()=>{const {c}=setup(()=>{throw Error('offline')});await c.loadConversations();assert.match(c.conversationList.innerHTML,/もう一度読み込む/)});
test('message query failure is not presented as an empty conversation',async()=>{const {c}=setup(({table})=>table==='conversations'?{data:[conv('one','seller','2026-11-04')]}:table==='profiles'?{data:[]}:{error:Error('offline')});await c.loadConversations();assert.match(c.conversationList.innerHTML,/もう一度読み込む/);assert.doesNotMatch(c.conversationList.innerHTML,/チャットを開始できます/)});
test('background list load cannot change home shell',async()=>{const s=setup(()=>assert.fail('no request expected'));s.page('home');await s.c.loadConversations();assert.equal(s.calls.length,0)});
function openSetup({pauseAtSeen=false}={}){
 const d=deferred(),effects=[];let page='messages',reads=0;
 const c=vm.createContext({currentUser:{id:'buyer'},currentConversationId:null,currentConversation:null,currentConversationPartner:null,currentConversationGroupIds:[],conversationOpenRequest:0,chatHistoryLimit:500,saveChatDraft(){},restoreChatDraft(){},clearChatNotice(){},isConversationHidden:()=>false,info(){},document:{querySelector:()=>({id:page}),getElementById:()=>{effects.push('hide button');return null}},conversationList:{style:{}},chatBox:{classList:{add:()=>effects.push('chat')}},chatTitle:{},chatSub:{},setShellMode(){},writeUIState(){},saveChatState(){},markConversationSeen:()=>d.promise,sb:{from(){const q={select(){return q},eq(){return q},single(){return pauseAtSeen?Promise.resolve({data:{id:'chat',buyer_id:'buyer',seller_id:'seller'}}):d.promise},or(){return q},order(){return q},then(resolve){reads++;return Promise.resolve({data:[{id:'chat'}]}).then(resolve)}};return q}}});
 vm.runInContext(html.slice(html.indexOf('async function openConversation('),html.indexOf('function closeChat()')),c);
 return {c,d,effects,page:id=>page=id,reads:()=>reads};
}
for(const change of ['account','page'])test(`pending chat open cannot reopen after ${change} change`,async()=>{const s=openSetup();const p=s.c.openConversation('chat');if(change==='account')s.c.currentUser={id:'other'};else s.page('home');s.d.resolve({data:{id:'chat',buyer_id:'buyer',seller_id:'seller'}});await p;assert.deepEqual(s.effects,[]);assert.equal(s.reads(),0)});
test('leaving chat during read acknowledgement prevents stale controls and downstream loaders',async()=>{const s=openSetup({pauseAtSeen:true});const p=s.c.openConversation('chat');for(let i=0;i<8;i++)await Promise.resolve();assert.deepEqual(s.effects,['chat']);s.c.conversationOpenRequest++;s.c.currentConversationId=null;s.d.resolve();await p;assert.deepEqual(s.effects,['chat'])});
for(const failure of ['query','network'])test(`chat ${failure} failure preserves current conversation and draft`,async()=>{
 const s=openSetup();const alerts=[];s.c.alert=x=>alerts.push(x);s.c.currentConversationId='previous';s.c.currentConversation={id:'previous'};
 const drafts=[];s.c.restoreChatDraft=id=>drafts.push(id);
 const p=s.c.openConversation('next');assert.equal(s.c.currentConversationId,'previous');
 if(failure==='query')s.d.resolve({error:Error('offline')});else s.d.reject(Error('offline'));
 await p;assert.equal(s.c.currentConversationId,'previous');assert.equal(s.c.currentConversation.id,'previous');assert.deepEqual(drafts,[]);assert.equal(alerts.length,1);
});
