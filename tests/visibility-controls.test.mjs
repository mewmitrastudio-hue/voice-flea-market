import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const controls=html.slice(html.indexOf('async function refreshVisibilityControls('),html.indexOf('function getHiddenConversationIdsForCurrentUser('));
const unblock=html.slice(html.indexOf('const unblockManagerPending='),html.indexOf('async function loadConversations('));
function setup({page='home',overlay=false,request=async()=>({})}={}){
 const calls=[];const chain={delete(){return this},eq(k,v){calls.push([k,v]);return k==='blocker_id'?request():this}};
 const c=vm.createContext({currentUser:{id:'buyer'},currentConversationId:null,sb:{from:()=>chain},confirm:()=>true,alert:()=>calls.push('alert'),safeLocalStorage:{removeItem:()=>calls.push('remove'),setItem(){}},hiddenConversationKey:id=>id,closeChat:()=>calls.push('close'),document:{getElementById:()=>({classList:{contains:()=>overlay}}),querySelector:()=>({id:page})},refreshSafetyManagement:async()=>calls.push('overlay'),renderVisibilityBlockManager:async()=>calls.push('manager'),loadConversations:async()=>calls.push('messages'),loadMe:async()=>calls.push('me')});
 vm.runInContext(controls+unblock,c);return {c,calls};
}
test('restore refreshes the open management overlay and profile',async()=>{const {c,calls}=setup({page:'me',overlay:true});await c.restoreConversationForMe('chat');assert.deepEqual(calls,['remove','overlay','me']);});
test('restore on home does not switch to messages',async()=>{const {c,calls}=setup();await c.restoreConversationForMe('chat');assert.deepEqual(calls,['remove','manager']);});
test('message refresh preserves an open conversation',async()=>{const {c,calls}=setup({page:'messages'});await c.refreshVisibilityControls('buyer');assert.ok(calls.includes('messages'));calls.length=0;c.currentConversationId='chat';await c.refreshVisibilityControls('buyer');assert.deepEqual(calls,['manager']);});
test('repeated unblock sends one deletion while pending',async()=>{let finish;const pending=new Promise(r=>finish=r);const {c,calls}=setup({request:()=>pending});const first=c.unblockUserFromManager('block');await c.unblockUserFromManager('block');assert.equal(calls.filter(x=>Array.isArray(x)&&x[0]==='id').length,1);finish({});await first;});
test('account change during unblock suppresses old account UI updates',async()=>{let finish;const {c,calls}=setup({request:()=>new Promise(r=>finish=r)});const pending=c.unblockUserFromManager('block');c.currentUser={id:'other'};finish({});await pending;assert.ok(!calls.includes('manager'));assert.deepEqual(calls[1],['blocker_id','buyer']);});
test('network failure unlocks retry',async()=>{let attempts=0;const {c,calls}=setup({request:async()=>{attempts++;throw Error('offline')}});await c.unblockUserFromManager('block');await c.unblockUserFromManager('block');assert.equal(attempts,2);assert.equal(calls.filter(x=>x==='alert').length,2);});
