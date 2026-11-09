import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const dialogCode=html.slice(html.indexOf('let cancelVoiceDialog=null;'),html.indexOf('// Account deletion must be performed'));
const unblockCode=html.slice(html.indexOf('const unblockManagerPending='),html.indexOf('let conversationListRequest='));
const cancelCode=html.slice(html.indexOf('const cancellingMessages='),html.indexOf('const sendingChatConversations='));
const favoriteCode=html.slice(html.indexOf('const favoriteListingPending='),html.indexOf('async function loadFavoriteBadge('));
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function dom({unsupported=false}={}){
 const nodes=[],focus={isConnected:true,focus(){document.activeElement=this;}};
 const document={activeElement:focus,body:{append(){}},createElement(tag){const node={tag,handlers:{},attrs:{},children:[],isConnected:true,open:false,append(...xs){this.children.push(...xs);},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.handlers[k]=v;},focus(){document.activeElement=this;},showModal(){if(unsupported)throw Error('unsupported');this.open=true;},close(){this.open=false;},remove(){this.isConnected=false;},click(){this.handlers.click?.();}};nodes.push(node);return node;}};
 const c=vm.createContext({document});vm.runInContext(dialogCode,c);return {c,nodes,focus,document};
}
test('notice uses purple native modal, text-only content, close label and restored focus',async()=>{
 const f=dom();const p=f.c.voiceNotice('<img src=x onerror=attack()>');const [dialog,heading,body,,cancel,accept]=f.nodes;
 assert.equal(dialog.className,'koe-account-dialog');assert.equal(dialog.open,true);assert.equal(body.textContent,'<img src=x onerror=attack()>');assert.equal(accept.textContent,'閉じる');assert.equal(f.document.activeElement,accept);
 assert.equal(dialog.attrs['aria-labelledby'],heading.id);accept.click();assert.equal(await p,true);assert.equal(f.document.activeElement,f.focus);assert.equal(dialog.isConnected,false);
});
test('confirmation initially focuses cancel; cancel, Escape and private reset all fail closed',async()=>{
 for(const way of ['button','escape','reset']){const f=dom(),p=f.c.showVoiceDialog({message:'確認',cancellable:true});const [dialog,,,,cancel]=f.nodes;assert.equal(f.document.activeElement,cancel);
 if(way==='button')cancel.click();else if(way==='escape')dialog.handlers.cancel({preventDefault(){}});else vm.runInContext('cancelVoiceDialog()',f.c);
 assert.equal(await p,false);}
});
test('Tab and shift Tab stay within dialog',async()=>{
 const f=dom(),p=f.c.showVoiceDialog({message:'確認',cancellable:true});const [dialog,,,,cancel,accept]=f.nodes;let prevented=0;
 dialog.handlers.keydown({key:'Tab',shiftKey:true,preventDefault(){prevented++;}});assert.equal(f.document.activeElement,accept);
 dialog.handlers.keydown({key:'Tab',shiftKey:false,preventDefault(){prevented++;}});assert.equal(f.document.activeElement,cancel);assert.equal(prevented,2);cancel.click();await p;
});
test('overlapping dialogs do not replace an unanswered confirmation',async()=>{
 const f=dom(),p=f.c.showVoiceDialog({message:'先の確認',cancellable:true});assert.equal(await f.c.showVoiceDialog({message:'後の確認',cancellable:true}),false);assert.equal(f.nodes.length,6);f.nodes[4].click();await p;
});
test('account confirmation takes priority and unsupported modal cannot authorize actions',async()=>{
 const f=dom();f.c.cancelAccountDialog=()=>{};assert.equal(await f.c.showVoiceDialog({message:'確認',cancellable:true}),false);assert.equal(f.nodes.length,0);
 const u=dom({unsupported:true});assert.equal(await u.c.showVoiceDialog({message:'確認',cancellable:true}),false);assert.equal(u.nodes[0].isConnected,false);
});
test('only bounded known diagnostic codes are visible; raw errors and secrets never appear',async()=>{
 const c=vm.createContext({});vm.runInContext(dialogCode,c);const messages=[];c.voiceNotice=m=>messages.push(m);
 for(const code of ['23505','PGRST116','secret-token','https://private.invalid','23505\npassword'])c.voiceActionError('変更できませんでした。',{code,message:'secret raw backend details'});
 assert.match(messages[0],/23505/);assert.match(messages[1],/PGRST116/);for(const m of messages.slice(2))assert.equal(m,'変更できませんでした。');assert.ok(messages.every(m=>!m.includes('secret raw')));
});
function actionSetup(kind){
 const answers=[],calls=[],notices=[];const c=vm.createContext({pageNavigationRequest:0,currentUser:{id:'owner'},currentConversationId:'chat',showVoiceDialog:opts=>{const d=deferred();answers.push({...d,opts});return d.promise;},voiceActionError:(m,e)=>notices.push(m),refreshVisibilityControls:async()=>calls.push('refresh'),loadChatMessages:async()=>calls.push('refresh'),loadMessageBadge:()=>calls.push('badge'),sb:{from(table){calls.push(table);return {delete(){return this;},update(){return this;},eq(k,v){calls.push([k,v]);return this;},then(resolve){resolve({});}}}}});
 vm.runInContext(kind==='unblock'?unblockCode:cancelCode,c);const run=()=>kind==='unblock'?c.unblockUserFromManager('block'):c.cancelSentMessage('message');return {c,answers,calls,notices,run};
}
for(const kind of ['unblock','cancel']){
 test(`${kind}: confirmation waits, duplicate entry suppressed, cancellation unlocks`,async()=>{const f=actionSetup(kind),p=f.run();await f.run();assert.equal(f.answers.length,1);assert.deepEqual(f.calls,[]);f.answers[0].resolve(false);await p;assert.deepEqual(f.calls,[]);const again=f.run();assert.equal(f.answers.length,2);f.answers[1].resolve(false);await again;});
 test(`${kind}: account switch before acceptance cannot mutate either account`,async()=>{const f=actionSetup(kind),p=f.run();f.c.currentUser={id:'other'};f.answers[0].resolve(true);await p;assert.deepEqual(f.calls,[]);});
 test(`${kind}: confirmed action stays scoped to original owner`,async()=>{const f=actionSetup(kind),p=f.run();f.answers[0].resolve(true);await p;assert.ok(f.calls.some(x=>Array.isArray(x)&&x[1]==='owner'));assert.ok(f.calls.includes('refresh'));});
 test(`${kind}: transport failure displays next step and never retries automatically`,async()=>{const f=actionSetup(kind);f.c.sb.from=()=>{f.calls.push('request');throw Error('secret')};const p=f.run();f.answers[0].resolve(true);await p;assert.deepEqual(f.calls,['request']);assert.equal(f.notices.length,1);assert.match(f.notices[0],/開き直して/);assert.ok(!f.notices[0].includes('secret'));});
}
test('message cancellation cannot apply after switching conversations',async()=>{const f=actionSetup('cancel'),p=f.run();f.c.currentConversationId='other';f.answers[0].resolve(true);await p;assert.deepEqual(f.calls,[]);});
function favorites(){
 const read=deferred(),write=deferred(),calls=[],notices=[],button={disabled:false,setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]}};
 const c=vm.createContext({pageNavigationRequest:0,currentUser:{id:'owner'},voiceNotice:m=>notices.push(m),voiceActionError:m=>notices.push(m),document:{getElementById:()=>null},loadFavoriteBadge:async()=>{},loadHome:async()=>{},sb:{from(){return {select(){return this},eq(){return this},maybeSingle(){calls.push('read');return read.promise},insert(data){calls.push(data);return write.promise},delete(){calls.push('delete');return this},then(resolve,reject){return write.promise.then(resolve,reject)}}}}});vm.runInContext(favoriteCode,c);return {c,read,write,calls,notices,button};
}
test('favorite loading disables button, suppresses double tap, then restores button',async()=>{const f=favorites(),p=f.c.toggleFavoriteListing('listing',f.button);await f.c.toggleFavoriteListing('listing',f.button);assert.equal(f.button.disabled,true);assert.equal(f.button['aria-busy'],'true');assert.deepEqual(f.calls,['read']);f.read.resolve({data:null});await tick();assert.equal(f.calls[1].user_id,'owner');f.write.resolve({});await p;assert.equal(f.button.disabled,false);assert.equal(f.button['aria-busy'],undefined);});
test('favorite failed read cannot become a write',async()=>{const f=favorites(),p=f.c.toggleFavoriteListing('listing',f.button);f.read.resolve({error:{code:'offline'}});await p;assert.deepEqual(f.calls,['read']);assert.equal(f.notices.length,1);assert.equal(f.button.disabled,false);});
test('favorite account switch while reading cannot mutate new account',async()=>{const f=favorites(),p=f.c.toggleFavoriteListing('listing',f.button);f.c.currentUser={id:'other'};f.read.resolve({data:null});await p;assert.deepEqual(f.calls,['read']);assert.equal(f.notices.length,0);assert.equal(f.button.disabled,false);});
test('navigation/reset dismiss everyday confirmation; financial browser confirms remain explicit',()=>{assert.match(html,/async function go\(id,opts=\{\}\)\{if\(typeof cancelVoiceDialog==='function'\)cancelVoiceDialog\(\)/);assert.match(html,/if\(typeof cancelAccountDialog==='function'\)cancelAccountDialog\(\);\s*if\(typeof cancelVoiceDialog==='function'\)cancelVoiceDialog\(\)/);assert.match(html,/購入代金の与信を解除/);assert.doesNotMatch(dialogCode,/window\.(alert|confirm)\s*=/);});

for(const kind of ['unblock','cancel'])test(`${kind}: navigation immediately after confirmation cannot apply stale action`,async()=>{const f=actionSetup(kind),p=f.run();f.answers[0].resolve(true);f.c.pageNavigationRequest++;await p;assert.deepEqual(f.calls,[]);});
