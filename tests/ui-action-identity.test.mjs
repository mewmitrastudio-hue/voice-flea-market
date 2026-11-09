import test from 'node:test';import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const h=fs.readFileSync(process.env.QA_HTML || new URL('../index.html',import.meta.url),'utf8');
function extract(a,b){return h.slice(h.indexOf(a),h.indexOf(b,h.indexOf(a)));}
function deferred(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}}
// Exact application functions, mocked endpoints; no network calls.
test('deletion does not use the replacement account session',async()=>{
const d=deferred(),calls=[];const c=vm.createContext({currentUser:{id:'A'},sb:{auth:{getSession:()=>d.promise,signOut:async()=>{}},functions:{invoke:async(n,p)=>{calls.push({n,p});return {data:{success:true}}}}},confirm:()=>true,prompt:()=> '削除',alert(){},location:{reload(){}},console});
vm.runInContext(extract('let accountDeletionInProgress=','async function signOut('),c);c.showAccountDialog=async()=>true;const p=c.requestAccountDeletion();await Promise.resolve();await Promise.resolve();await Promise.resolve();c.currentUser={id:'B'};d.resolve({data:{session:{user:{id:'B'},access_token:'B_TOKEN'}}});await p;assert.equal(calls.length,0);
});
test('listing upload cannot switch its seller to another account',async()=>{
const d=deferred(),calls=[];const c=vm.createContext({currentUser:{id:'A'},sellTitle:{value:'A title'},sellDesc:{value:'A description'},sellPrice:{value:'1000'},sellDays:{value:'3'},sellAudio:{files:[{name:'test.mp3',type:'audio/mpeg'}]},sellCategory:{value:'voice'},sellAI:{value:'no'},crypto:{randomUUID:()=> 'uuid'},validWholeNumber:()=>true,info(){},loadHome(){},sb:{storage:{from:()=>({upload:()=>d.promise})},from:()=>({insert:async x=>{calls.push(x);return {}}})}});
vm.runInContext(extract('async function createListing(){','/* 購入時のエラーを'),c);const p=c.createListing();c.currentUser={id:'B'};d.resolve({});await p;assert.equal(calls.length,0);
});
test('profile upload cannot update a replacement account',async()=>{
const d=deferred(),calls=[];const fields={profileDisplayName:{value:'A name'},profileAvatarFile:{files:[{name:'a.png',type:'image/png',size:20}]}};
const c=vm.createContext({currentUser:{id:'A'},document:{getElementById:id=>fields[id]},crypto:{randomUUID:()=> 'uuid'},info(){},setTimeout(){},sb:{storage:{from:()=>({upload:()=>d.promise})},from:()=>({update:x=>({eq:async(k,v)=>{calls.push({x,k,v});return {}}})})}});
vm.runInContext(extract('async function saveBasicProfile(){','function openProfileSafety('),c);const p=c.saveBasicProfile();c.currentUser={id:'B'};d.resolve({});await p;assert.equal(calls.length,0);
});
test('block confirmation cannot switch to a different profile target',async()=>{
const d=deferred(),calls=[];const c=vm.createContext({currentUser:{id:'A'},safetyRequest:0,safetyMode:'profile',safetyTargetUserId:'target1',getBlockRows:()=>d.promise,sb:{from:()=>({insert:async x=>{calls.push(x);return {}}})},cancelBlockConfirm(){},refreshBlockButton:async()=>{},applyChatBlockState:async()=>{},document:{getElementById:()=>null}});
vm.runInContext(extract('async function confirmBlockCurrentPartner(){','async function applyChatBlockState(){'),c);const p=c.confirmBlockCurrentPartner();c.safetyTargetUserId='target2';d.resolve([]);await p;assert.equal(calls.length,0);
});
test('deletion rejects a mismatched token even when UI still shows the original account',async()=>{
 const calls=[];const c=vm.createContext({currentUser:{id:'A'},sb:{auth:{getSession:async()=>({data:{session:{user:{id:'B'},access_token:'B_TOKEN'}}})},functions:{invoke:async()=>{calls.push('invoke');return {}}}},confirm:()=>true,prompt:()=> '削除',alert(){},console:{error(){}}});vm.runInContext(extract('let accountDeletionInProgress=','async function signOut('),c);c.showAccountDialog=async()=>true;await c.requestAccountDeletion();assert.equal(calls.length,0);
});
test('deletion still invokes once when confirmed user and session match',async()=>{
 const calls=[];const c=vm.createContext({currentUser:{id:'A'},sb:{auth:{getSession:async()=>({data:{session:{user:{id:'A'},access_token:'A_TOKEN'}}}),signOut:async()=>calls.push('signOut')},functions:{invoke:async(n,p)=>{calls.push(p.headers.Authorization);return {data:{success:true}}}}},confirm:()=>true,prompt:()=> '削除',alert(){},location:{reload:()=>calls.push('reload')},console});vm.runInContext(extract('let accountDeletionInProgress=','async function signOut('),c);c.showAccountDialog=async()=>true;await c.requestAccountDeletion();assert.deepEqual(calls,['Bearer A_TOKEN','signOut','reload']);
});
test('listing retains validated snapshot while upload is pending',async()=>{
 const d=deferred(),calls=[];const c=vm.createContext({currentUser:{id:'A'},sellTitle:{value:'Original'},sellDesc:{value:'Description'},sellPrice:{value:'1000'},sellDays:{value:'3'},sellAudio:{files:[{name:'voice.mp3',type:'audio/mpeg'}]},sellCategory:{value:'voice'},sellAI:{value:'no'},crypto:{randomUUID:()=> 'uuid'},validWholeNumber:()=>true,info(){},loadHome(){},sb:{storage:{from:()=>({upload:()=>d.promise})},from:()=>({insert:async x=>{calls.push(x);return {}}})}});vm.runInContext(extract('async function createListing(){','/* 購入時のエラーを'),c);const p=c.createListing();c.sellTitle.value='Changed';c.sellPrice.value='0';d.resolve({});await p;assert.equal(calls.length,1);assert.equal(calls[0].seller_id,'A');assert.equal(calls[0].title,'Original');assert.equal(calls[0].price_jpy,1000);
});
test('profile retains original text alongside the uploaded avatar',async()=>{
 const d=deferred(),calls=[];const fields={profileDisplayName:{value:'Original'},profileBio:{value:'Original bio'},profileAvatarFile:{files:[{name:'a.png',type:'image/png',size:20}]}};const c=vm.createContext({currentUser:{id:'A'},document:{getElementById:id=>fields[id]},crypto:{randomUUID:()=> 'uuid'},info(){},setTimeout(){},sb:{storage:{from:()=>({upload:()=>d.promise})},from:()=>({update:x=>({eq:async(k,v)=>{calls.push({x,k,v});return {}}})})}});vm.runInContext(extract('async function saveBasicProfile(){','function openProfileSafety('),c);const p=c.saveBasicProfile();fields.profileBio.value='Changed';d.resolve({});await p;assert.equal(calls[0].v,'A');assert.equal(calls[0].x.profile_bio,'Original bio');assert.equal(calls[0].x.avatar_path,'A/uuid.png');
});
test('block confirmation still blocks the confirmed target when identity is unchanged',async()=>{
 const calls=[];const c=vm.createContext({currentUser:{id:'A'},safetyRequest:0,safetyMode:'profile',safetyTargetUserId:'target1',getBlockRows:async()=>[],sb:{from:()=>({insert:async x=>{calls.push(x);return {}}})},cancelBlockConfirm(){},refreshBlockButton:async()=>{},applyChatBlockState:async()=>{},document:{getElementById:()=>null}});vm.runInContext(extract('async function confirmBlockCurrentPartner(){','async function applyChatBlockState(){'),c);await c.confirmBlockCurrentPartner();assert.equal(calls.length,1);assert.equal(calls[0].blocker_id,'A');assert.equal(calls[0].blocked_user_id,'target1');
});
for(const name of ['createListing','saveBasicProfile'])test(`${name} UI action guard prevents repeated submission and unlocks failed retries`,async()=>{
 let calls=0;const first=deferred(),notices=[];const c=vm.createContext({document:{querySelectorAll:()=>[]},console:{warn(){}},info:(_,message)=>notices.push(message)});c.window=c;c[name]=async()=>{calls++;if(calls===1)return first.promise;return 'retried'};
 vm.runInContext(extract('function protectAction(',"for(const [name,msg,keyed]"),c);c.protectAction(name,'status');const pending=c[name]();await c[name]();assert.equal(calls,1);first.resolve(Promise.reject(new Error('offline')));await pending;assert.equal(notices.length,1);assert.equal(await c[name](),'retried');assert.equal(calls,2);
 assert.match(h.slice(h.indexOf('for(const [name,msg,keyed]'),h.indexOf('init();',h.indexOf('for(const [name,msg,keyed]'))),new RegExp("\\['"+name+"','"));
});
