import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function boostRead('),html.indexOf('async function purchaseBoost('));
function screen(listings=[]){
 const notices=[],select={value:'',replaceChildren(){},add(){}},history={textContent:''};
 const plugin={pendingTransactions:async()=>({transactions:[]}),products:async()=>({environment:'Sandbox',products:[{id:'silver'}]})};
 const context=vm.createContext({setTimeout,clearTimeout,Option:class{},formatJpDateTime:()=>'',currentUser:{id:'owner'},boostRequest:0,boostOwnHistory:[],boostHistoryReady:false,boostReady:false,boostStoreProducts:[],boostEnvironment:null,boostListingChanged(){},boostNotice:t=>notices.push(t),isNativeBoost:()=>true,boostApi:async()=>({enabled:true,environment:'Sandbox'}),nativeBoost:async()=>({plugin}),document:{getElementById:id=>id==='boostPreviewOverlay'?{classList:{add(){},contains(){return false}}}:id==='boostListingSelect'?select:history},sb:{from:table=>({select(){return this},eq(){return this},order(){return table==='listings'?Promise.resolve({data:listings}):this},limit:async()=>({data:[]})})}});
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
  if(method==='products')return {environment:'Sandbox',products:[{id:'com.ayuhide.koenofurima.boost.silver',displayPrice:'¥300',currencyCode:'JPY'}]};
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
 const context=vm.createContext({isNativeBoost:()=>true,openBoostPreview:async()=>{},boostRequest:0,boostOwnHistory:[],boostHistoryReady:true,boostBusy:false,boostPurchasePlan:null,boostReady:true,currentUser:{id:'owner'},boostEnvironment:'Sandbox',boostStoreProducts:['silver','gold','platinum'].map(p=>({id:'com.ayuhide.koenofurima.boost.'+p,displayPrice:'¥300',currencyCode:'JPY'})),nativeBoost:async()=>({plugin}),boostNotice:t=>notices.push(t),formatJpDateTime:()=>'',boostApi:body=>{calls.push(body.action);reached[body.action].resolve();return body.action==='prepare'?order.promise:verify.promise},document:{getElementById:()=>({value:'listing'}),querySelectorAll:()=>buttons}});
 vm.runInContext(html.slice(html.indexOf('function boostActiveListing('),html.indexOf('// Bound read-only')),context);
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
test('active boost blocks every plan before preparing another purchase',async()=>{
 const s=purchaseScreen();s.context.boostOwnHistory=[{listing_id:'listing',status:'active',ends_at:'2999-01-01'}];
 s.context.boostListingChanged();assert.ok(s.buttons.every(b=>b.disabled&&b.textContent.includes('利用中')));
 await s.context.purchaseBoost('gold');await s.context.purchaseBoost('platinum');
 assert.deepEqual(s.calls,[]);assert.match(s.notices.at(-1),/別の出品/);
 s.context.boostOwnHistory[0].ends_at='2000-01-01';s.context.boostListingChanged();assert.ok(s.buttons.every(b=>!b.disabled));
});
test('only confirmed yen metadata is displayed as the purchase amount',()=>{
 const s=purchaseScreen();assert.equal(s.context.boostProductPrice({currencyCode:'JPY',displayPrice:'¥300'}),'¥300');
 assert.equal(s.context.boostProductPrice({currencyCode:'USD',displayPrice:'$1.99'}),null);
 assert.equal(s.context.boostProductPrice({displayPrice:'$1.99'}),null);
 s.context.boostStoreProducts=s.context.boostStoreProducts.map(p=>({...p,currencyCode:'USD',displayPrice:'$1.99'}));
 s.context.boostListingChanged();assert.ok(s.buttons.every(b=>b.textContent==='Appleで価格を確認'&&!b.disabled));
});
test('HTTP errors preserve the server rejection reason and tolerate unreadable error bodies',async()=>{
 const context=vm.createContext({sb:{functions:{invoke:async()=>({error:{context:{json:async()=>({error:'有効なブーストがある場合は期間終了後に購入できます。'})}}})}}});
 vm.runInContext(html.slice(html.indexOf('async function boostApi('),html.indexOf('function boostNotice(')),context);
 await assert.rejects(context.boostApi({action:'prepare'}),/有効なブースト/);
 context.sb.functions.invoke=async()=>({error:{context:{json:async()=>{throw Error('not JSON')}}}});
 await assert.rejects(context.boostApi({}),/購入情報を確認できません/);
});
test('purchase refreshes history immediately after verified delivery and finish',async()=>{
 const s=purchaseScreen();let refreshed=0;
 s.context.openBoostPreview=async id=>{assert.equal(id,'listing');assert.deepEqual(s.calls,['pending','prepare','purchase','verify','finish']);refreshed++;s.context.boostHistoryReady=true;s.context.boostReady=true;s.context.boostOwnHistory=[{listing_id:id,status:'active',ends_at:'2999-01-01'}];};
 const run=s.context.purchaseBoost('silver');s.pending.resolve({transactions:[]});s.order.resolve({orderId:'order',productId:'silver'});s.purchase.resolve({status:'purchased',signedTransaction:'signed',transactionId:'tx'});s.verify.resolve({success:true,endsAt:'2999-01-01'});s.finish.resolve();await run;
 assert.equal(refreshed,1);assert.ok(s.buttons.every(b=>b.disabled&&b.textContent.includes('利用中')));assert.match(s.notices.at(-1),/反映が完了/);
});
test('reconciliation refreshes available plans without asking to close and reopen',async()=>{
 const s=purchaseScreen();let refreshed=0;
 vm.runInContext(html.slice(html.indexOf('async function reconcileBoostPurchases('),html.indexOf('function closeBoostPreview(')),s.context);
 s.context.openBoostPreview=async()=>{refreshed++;s.context.boostReady=true;s.context.boostHistoryReady=true;};
 const run=s.context.reconcileBoostPurchases();assert.ok(s.buttons.every(b=>b.disabled));
 s.pending.resolve({transactions:[{signedTransaction:'signed',transactionId:'tx'}]});s.verify.resolve({success:true});s.finish.resolve();await run;
 assert.equal(refreshed,1);assert.deepEqual(s.calls,['pending','verify','finish']);assert.ok(s.buttons.every(b=>!b.disabled));assert.match(s.notices.at(-1),/履歴を更新/);
});
test('verification failure never finishes a receipt or labels the screen as preparing',async()=>{
 const s=purchaseScreen();vm.runInContext(html.slice(html.indexOf('async function reconcileBoostPurchases('),html.indexOf('function closeBoostPreview(')),s.context);
 const run=s.context.reconcileBoostPurchases();s.pending.resolve({transactions:[{signedTransaction:'signed',transactionId:'tx'}]});s.verify.resolve({success:false});await run;
 assert.deepEqual(s.calls,['pending','verify']);assert.ok(s.buttons.every(b=>b.disabled&&b.textContent==='購入状況を確認してください'));assert.equal(s.context.boostBusy,false);
});

test('web reconciliation does not call native purchase APIs or alter purchase state',async()=>{
 const s=purchaseScreen();s.context.isNativeBoost=()=>false;
 vm.runInContext(html.slice(html.indexOf('async function reconcileBoostPurchases('),html.indexOf('function closeBoostPreview(')),s.context);
 await s.context.reconcileBoostPurchases();
 assert.deepEqual(s.calls,[]);assert.equal(s.context.boostBusy,false);assert.equal(s.context.boostReady,true);
 assert.match(s.notices.at(-1),/iPhoneアプリ/);
});
for(const plan of ['silver','gold','platinum'])test(`verified ${plan} purchase completes in order and uses the server product`,async()=>{
 const s=purchaseScreen();let purchaseArgs;
 s.context.nativeBoost=async()=>({plugin:{pendingTransactions:async()=>({transactions:[]}),purchase:async args=>{purchaseArgs=args;return {status:'purchased',signedTransaction:'signed',transactionId:'tx'};},finish:async()=>{s.calls.push('finish');}}});
 const run=s.context.purchaseBoost(plan);
 s.order.resolve({orderId:'order',productId:'com.ayuhide.koenofurima.boost.'+plan});
 s.verify.resolve({success:true,environment:'Sandbox'});await run;
 assert.equal(purchaseArgs.productId,'com.ayuhide.koenofurima.boost.'+plan);assert.equal(purchaseArgs.orderId,'order');assert.equal(purchaseArgs.environment,'Sandbox');
 assert.deepEqual(s.calls,['prepare','verify','finish']);assert.equal(s.context.boostBusy,false);assert.match(s.notices.at(-1),/反映が完了/);
});
