import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function cancelBlockConfirm(){'),html.indexOf('async function confirmBlockCurrentPartner(){'));
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}
function setup(read=async()=>[]){
 const elements=new Map(),messages=[],deletes=[];
 const el=id=>{if(!elements.has(id)){const classes=new Set();elements.set(id,{value:'',innerHTML:'',textContent:'',options:[],style:{},disabled:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x)}}});}return elements.get(id);};
 const c=vm.createContext({safetyRequest:0,safetyMode:'profile',safetyTargetUserId:'targetA',currentConversationPartner:'targetA',currentUser:{id:'owner'},document:{getElementById:el},info:(id,message)=>messages.push(message),applyChatBlockState:async()=>{},sb:{from:()=>({delete(){return this},eq(k,v){deletes.push([k,v]);return this},then(resolve){resolve({})}})}});
 vm.runInContext(code,c);c.getBlockRows=read;
 return {c,el,messages,deletes};
}
test('report dialog opens before block lookup and remains available on failure',async()=>{
 const d=deferred(),{c,el,messages}=setup(()=>d.promise);const p=c.openSafetyCenter('profile');
 assert.equal(el('safetyOverlay').classList.contains('on'),true);assert.equal(el('blockUserBtn').disabled,true);
 d.reject(Error('offline'));await p;
 assert.equal(el('safetyOverlay').classList.contains('on'),true);assert.match(messages[0],/通報は送信できます/);assert.equal(el('blockUserBtn').textContent,'ブロック状態を再確認');
});
test('closing while lookup runs does not reopen or update the safety dialog',async()=>{
 const d=deferred(),{c,el}=setup(()=>d.promise);const p=c.openSafetyCenter('profile');c.closeSafetyCenter();el('blockUserBtn').textContent='closed';d.resolve([]);await p;
 assert.equal(el('safetyOverlay').classList.contains('on'),false);assert.equal(el('blockUserBtn').textContent,'closed');
});
for(const change of ['target','account'])test(`stale block lookup cannot change replacement ${change} UI`,async()=>{
 const d=deferred(),{c,el,messages}=setup(()=>d.promise);const p=c.refreshBlockButton();if(change==='target')c.safetyTargetUserId='targetB';else c.currentUser={id:'other'};el('blockUserBtn').textContent='replacement';d.resolve([{blocker_id:'owner'}]);await p;
 assert.equal(el('blockUserBtn').textContent,'replacement');assert.equal(messages.length,0);
});
for(const change of ['target','account','close'])test(`unblock lookup cannot delete after ${change} changes`,async()=>{
 const d=deferred(),{c,deletes}=setup(()=>d.promise);const p=c.toggleBlockCurrentPartner();if(change==='target')c.safetyTargetUserId='targetB';else if(change==='account')c.currentUser={id:'other'};else c.closeSafetyCenter();d.resolve([{id:'blockA',blocker_id:'owner'}]);await p;assert.equal(deletes.length,0);
});
test('failed lookup never opens confirmation or sends unblock',async()=>{
 const {c,el,deletes}=setup(async()=>{throw Error('offline')});await c.toggleBlockCurrentPartner();assert.equal(deletes.length,0);assert.equal(el('blockConfirmBox').classList.contains('show'),false);
});
test('confirmed existing block deletion is scoped to the original owner',async()=>{
 const {c,deletes}=setup(async()=>[{id:'blockA',blocker_id:'owner'}]);await c.toggleBlockCurrentPartner();assert.deepEqual(deletes,[['id','blockA'],['blocker_id','owner']]);
});
test('unblocked target presents confirmation without mutating data',async()=>{
 const {c,el,deletes}=setup();await c.toggleBlockCurrentPartner();assert.equal(el('blockConfirmBox').classList.contains('show'),true);assert.equal(deletes.length,0);
});
test('late unblock transport failure cannot write into replacement account UI',async()=>{
 const d=deferred(),{c,messages}=setup(async()=>[{id:'blockA',blocker_id:'owner'}]);
 c.sb={from:()=>({delete(){return this},eq(){return this},then(resolve,reject){return d.promise.then(resolve,reject)}})};
 const p=c.toggleBlockCurrentPartner();await new Promise(r=>setImmediate(r));c.currentUser={id:'other'};d.reject(Error('offline'));await p;assert.equal(messages.length,0);
});
