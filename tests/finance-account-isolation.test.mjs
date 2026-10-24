import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const buyer='buyer',other='other';
function deferred(){let resolve;return{promise:new Promise(r=>resolve=r),resolve:x=>resolve(x)}}
function finance(){
 const request=deferred(),nodes=new Map(['stripeConnectBtn','stripeConnectStatus'].map(id=>[id,{textContent:'',disabled:false,classList:{remove(){},add(){}}}])),redirects=[];let invokes=0;
 const c={currentUser:{id:buyer},document:{getElementById:id=>nodes.get(id)},sb:{auth:{getSession:async()=>({data:{session:{access_token:'unit',user:{id:buyer}}}})},functions:{invoke:async()=>{invokes++;return request.promise;}}},stripeFunctionError:async()=> 'error',console:{warn(){}},window:{location:{assign:url=>redirects.push(url)}}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function getStripeSellerStatus(){'),html.indexOf('function showFinancePanel(')),c);return{c,request,nodes,redirects,invokes:()=>invokes};
}
test('seller status arriving after account switch is discarded',async()=>{
 const f=finance(),pending=f.c.getStripeSellerStatus();await Promise.resolve();f.c.currentUser={id:other};f.request.resolve({data:{verified:true},error:null});assert.equal(await pending,null);
});
test('seller onboarding never redirects a different account to an earlier account link',async()=>{
 const f=finance(),pending=f.c.connectStripeSeller();await Promise.resolve();f.c.currentUser={id:other};f.request.resolve({data:{accountId:'acct_unit',onboardingUrl:'https://connect.stripe.com/unit'},error:null});await pending;assert.equal(f.redirects.length,0);
 const g=finance();g.c.sb.auth.getSession=async()=>({data:{session:{access_token:'unit',user:{id:other}}}});await g.c.connectStripeSeller();assert.equal(g.invokes(),0);assert.equal(g.redirects.length,0);
});
test('notification reads stop immediately when account changes during the first query',async()=>{
 const first=deferred();let queries=0;
 const q={select(){return this},eq(){return this},then(resolve){queries++;return first.promise.then(resolve)}};
 const c={currentUser:{id:buyer},sb:{from:()=>q},safeLocalStorage:{getItem(){throw Error('No old account keys should be read')}},console:{warn(){}},bellBadge:{classList:{toggle(){}}}};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function getNotificationData(){'),html.indexOf('function notifTypeClass')),c);
 const pending=c.getNotificationData();await Promise.resolve();c.currentUser={id:other};first.resolve({data:[{id:'old-job',title:'Private old title'}]});const data=await pending;assert.equal(data.items.length,0);assert.equal(queries,1);
});
