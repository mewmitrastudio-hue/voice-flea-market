import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function boostRead('),html.indexOf('async function purchaseBoost('));
function screen(listings=[]){
 const notices=[],select={value:'',replaceChildren(){},add(){}},history={textContent:''};
 const plugin={pendingTransactions:async()=>({transactions:[]}),products:async()=>({environment:'Sandbox',products:[{id:'silver'}]})};
 const context=vm.createContext({setTimeout,clearTimeout,Option:class{},formatJpDateTime:()=>'',currentUser:{id:'owner'},boostRequest:0,boostReady:false,boostStoreProducts:[],boostEnvironment:null,boostListingChanged(){},boostNotice:t=>notices.push(t),isNativeBoost:()=>true,boostApi:async()=>({enabled:true,environment:'Sandbox'}),nativeBoost:async()=>({plugin}),document:{getElementById:id=>id==='boostPreviewOverlay'?{classList:{add(){}}}:id==='boostListingSelect'?select:history},sb:{from:table=>({select(){return this},eq(){return this},order(){return table==='listings'?Promise.resolve({data:listings}):this},limit:async()=>({data:[]})})}});
 vm.runInContext(source,context);return {context,notices,plugin};
}
test('without listings the screen explains the prerequisite without starting StoreKit',async()=>{
 const {context,notices}=screen();context.nativeBoost=()=>{throw Error('must not start StoreKit')};
 await context.openBoostPreview();assert.match(notices.at(-1),/ブーストできる出品がありません/);assert.equal(context.boostReady,false);
});
test('a stalled read leaves loading with a stage-specific error and later reads still work',async()=>{
 const {context}=screen();await assert.rejects(context.boostRead(()=>new Promise(()=>{}),'Appleの商品取得',5),/Appleの商品取得に時間がかかっています/);
 assert.equal(await context.boostRead(()=>42,'read',20),42);
});
test('completed Sandbox product loading enables selection and identifies the test environment',async()=>{
 const {context,notices}=screen([{id:'listing',title:'test'}]);await context.openBoostPreview('listing');
 assert.equal(context.boostReady,true);assert.equal(context.boostEnvironment,'Sandbox');assert.match(notices.at(-1),/^テスト購入です/);
 assert.ok(notices.includes('Appleから3プランの商品情報を取得しています…'));
});
test('the actual Capacitor proxy loads through async initialization and reaches native products',async()=>{
 const {context,notices}=screen([{id:'listing',title:'test'}]);
 const calls=[];
 context.webkit={messageHandlers:{bridge:{}}};
 context.Capacitor={PluginHeaders:[{name:'KoeBoost',methods:['products','pendingTransactions','purchase','finish'].map(name=>({name,rtype:'promise'}))}],nativePromise:async(name,method,options)=>{
  calls.push({name,method,options});
  if(method==='pendingTransactions')return {transactions:[]};
  if(method==='products')return {environment:'Sandbox',products:[{id:'com.ayuhide.koenofurima.boost.silver',displayPrice:'¥300'}]};
  throw Error('loading must not purchase or finish');
 }};
 const core=readFileSync(new URL('../node_modules/@capacitor/core/dist/index.js',import.meta.url),'utf8').replace(/^export \{.*\};$/m,'globalThis.testCore={registerPlugin};');
 vm.runInContext(core,context);
 context.loadCore=async()=>context.testCore;context.boostNative=null;
 const nativeSource=html.slice(html.indexOf('async function nativeBoost(){'),html.indexOf('async function boostApi(')).replace("import('./capacitor-core.js')",'loadCore()');
 vm.runInContext(nativeSource,context);
 // The real proxy has a callable `then`, unlike a plain-object test double.
 const raw=context.testCore.registerPlugin('KoeBoost');assert.equal(typeof raw.then,'function');
 await context.openBoostPreview('listing');
 assert.equal(context.boostReady,true);assert.match(notices.at(-1),/^テスト購入です/);
 assert.deepEqual(calls.map(x=>x.method),['pendingTransactions','products']);
 const again=await context.nativeBoost();assert.equal(again.plugin,raw);
 assert.equal(calls.length,2,'initialization must not dispatch a fictitious then method');
});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}
function purchaseScreen(){
 const pending=deferred(),order=deferred(),purchase=deferred(),verify=deferred(),finish=deferred();
 const reached={pending:deferred(),prepare:deferred(),purchase:deferred(),verify:deferred(),finish:deferred()};
 const calls=[],notices=[],buttons=['silver','gold','platinum'].map(plan=>({dataset:{boostBuy:plan},closest:()=>({querySelector:()=>({textContent:''})})}));
 const plugin={pendingTransactions:()=>{calls.push('pending');reached.pending.resolve();return pending.promise},purchase:()=>{calls.push('purchase');reached.purchase.resolve();return purchase.promise},finish:()=>{calls.push('finish');reached.finish.resolve();return finish.promise}};
 const context=vm.createContext({boostBusy:false,boostPurchasePlan:null,boostReady:true,currentUser:{id:'owner'},boostEnvironment:'Sandbox',boostStoreProducts:['silver','gold','platinum'].map(p=>({id:'com.ayuhide.koenofurima.boost.'+p,displayPrice:'¥300'})),nativeBoost:async()=>({plugin}),boostNotice:t=>notices.push(t),formatJpDateTime:()=>'',boostApi:body=>{calls.push(body.action);reached[body.action].resolve();return body.action==='prepare'?order.promise:verify.promise},document:{getElementById:()=>({value:'listing'}),querySelectorAll:()=>buttons}});
 vm.runInContext(html.slice(html.indexOf('function boostListingChanged(){'),html.indexOf('// Bound read-only')),context);
 vm.runInContext(html.slice(html.indexOf('async function purchaseBoost('),html.indexOf('async function reconcileBoostPurchases(')),context);
 return {context,pending,order,purchase,verify,finish,reached,calls,notices,buttons};
}
test('purchase responds immediately and repeated taps never create additional orders or purchases',async()=>{
 const s=purchaseScreen(),run=s.context.purchaseBoost('silver');
 assert.match(s.buttons[0].textContent,/購入画面を準備中/);assert.ok(s.buttons.every(x=>x.disabled));
 assert.match(s.notices.at(-1),/購入画面を準備/);
 await Promise.all([s.context.purchaseBoost('silver'),s.context.purchaseBoost('gold')]);
 await s.reached.pending.promise;s.pending.resolve({transactions:[]});
 await s.reached.prepare.promise;assert.deepEqual(s.calls,['pending','prepare']);
 await s.context.purchaseBoost('silver');s.order.resolve({orderId:'order',productId:'silver'});
 await s.reached.purchase.promise;assert.match(s.notices.at(-1),/購入画面を開いて/);
 await s.context.purchaseBoost('silver');s.purchase.resolve({status:'purchased',signedTransaction:'signed',transactionId:'tx'});
 await s.reached.verify.promise;assert.match(s.notices.at(-1),/出品への反映を確認/);assert.ok(s.buttons.every(x=>x.disabled));
 await s.context.purchaseBoost('silver');s.verify.resolve({success:true,environment:'Sandbox',endsAt:'2026-10-24'});
 await s.reached.finish.promise;s.finish.resolve();await run;
 assert.deepEqual(s.calls,['pending','prepare','purchase','verify','finish']);assert.equal(s.context.boostBusy,false);assert.match(s.notices.at(-1),/反映が完了/);
});
test('Apple cancellation releases the lock and never verifies or finishes a transaction',async()=>{
 const s=purchaseScreen(),run=s.context.purchaseBoost('silver');
 await s.reached.pending.promise;s.pending.resolve({transactions:[]});
 await s.reached.prepare.promise;s.order.resolve({orderId:'order',productId:'silver'});
 await s.reached.purchase.promise;s.purchase.resolve({status:'cancelled'});await run;
 assert.deepEqual(s.calls,['pending','prepare','purchase']);assert.equal(s.context.boostBusy,false);assert.equal(s.context.boostPurchasePlan,null);assert.ok(s.buttons.every(x=>!x.disabled));assert.match(s.notices.at(-1),/キャンセル/);
});
