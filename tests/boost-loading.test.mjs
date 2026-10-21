import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function boostRead('),html.indexOf('async function purchaseBoost('));
function screen(listings=[]){
 const notices=[],select={value:'',replaceChildren(){},add(){}},history={textContent:''};
 const plugin={pendingTransactions:async()=>({transactions:[]}),products:async()=>({environment:'Sandbox',products:[{id:'silver'}]})};
 const context=vm.createContext({setTimeout,clearTimeout,Option:class{},formatJpDateTime:()=>'',currentUser:{id:'owner'},boostRequest:0,boostReady:false,boostStoreProducts:[],boostEnvironment:null,boostListingChanged(){},boostNotice:t=>notices.push(t),isNativeBoost:()=>true,boostApi:async()=>({enabled:true,environment:'Sandbox'}),nativeBoost:async()=>plugin,document:{getElementById:id=>id==='boostPreviewOverlay'?{classList:{add(){}}}:id==='boostListingSelect'?select:history},sb:{from:table=>({select(){return this},eq(){return this},order(){return table==='listings'?Promise.resolve({data:listings}):this},limit:async()=>({data:[]})})}});
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
