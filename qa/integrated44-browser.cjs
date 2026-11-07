// Intercept every request. Synthetic local identity/data only; no real sign-in or backend changes.
const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(root+'/index.html','utf8');
const sdk=fs.readFileSync(root+'/tests/fixtures/vendor/supabase-js-2.119.0.umd.js','utf8');
const owner='6454e07c-ed0b-46b7-a8a1-aa63c555d634',other='44444444-4444-4444-8444-444444444444';
const authKey='sb-tyulybijubckitybgubc-auth-token';
function user(){return {id:owner,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',user_metadata:{display_name:'Synthetic QA'},app_metadata:{provider:'email'},created_at:'2026-01-01T00:00:00Z'}}
function session(){const claims={iss:'https://tyulybijubckitybgubc.supabase.co/auth/v1',aud:'authenticated',sub:owner,exp:Math.floor(Date.now()/1000)+7200};return {access_token:Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic',token_type:'bearer',expires_in:7200,expires_at:claims.exp,refresh_token:'synthetic-refresh',user:user()}}
const seeded={['vf_voice_attempt_'+other+':55555555-5555-4555-8555-555555555555']:'unknown old pending bytes', ['vf_pending_purchase_'+owner]:'corrupt old checkout bytes', 'vf_financial_resolution_pending_unknown':'DO NOT RESOLVE', 'vf_recording_neotkrfsquysuatdruhg_auth_v1':'OLD RECORDING SESSION', 'vf_scoped_neotkrfsquysuatdruhg_vf_voice_attempt_test':'recording pending', ['voice_flea_ui_'+other+'_draft_chat']:'keep original draft'};
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const results=[];
try{for(const scenario of ['existing-session','fresh-login','wrong-password']){
 let diagnosticUnavailable=false;
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),requests=[],errors=[];
 await context.addInitScript(({seeded,scenario,authKey,session})=>{if(!sessionStorage.getItem('qa-seeded')){for(const[k,v]of Object.entries(seeded))localStorage.setItem(k,v);if(scenario==='existing-session')localStorage.setItem(authKey,JSON.stringify(session));sessionStorage.setItem('qa-seeded','1')}window.Capacitor={isNativePlatform:()=>true,getPlatform:()=> 'ios'};window.__nativeCalls=[];},{seeded,scenario,authKey,session:session()});
 await context.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());requests.push({url:r.url(),method:r.method()});const reply=(body,type='application/json',status=200)=>route.fulfill({status,contentType:type,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','content-range':'0-0/0'},body:typeof body==='string'?body:JSON.stringify(body)});
 if(url.hostname==='qa.local'&&url.pathname==='/capacitor-core.js')return reply(`export function registerPlugin(){return {products:async ({productIds})=>{window.__nativeCalls.push('products');return {environment:'Sandbox',products:productIds.map(id=>({id,currencyCode:'JPY',price:id.includes('.voice.')?'1000':id.endsWith('silver')?'300':id.endsWith('gold')?'800':'1500'}))}}}}`,'application/javascript');
 if(url.hostname==='qa.local')return reply(html,'text/html');
 if(url.pathname==='/functions/v1/create-connect-account')return reply({accountId:null,verified:false});
 if(url.pathname==='/functions/v1/iap-readiness'){
  assert.equal(r.method(),'GET');assert.ok(r.headers().authorization?.startsWith('Bearer '));
  if(diagnosticUnavailable)return reply({error:'Fixture missing deployment'},'application/json',503);
  return reply({schemaVersion:1,scope:'authenticated_self_recipient_only',configuration:{voice:{enabled:true,environment:{effective:'Sandbox',explicitValid:true}},boost:{enabled:false,environment:{effective:'Sandbox',explicitValid:false}},apple:{minimumValid:true},stripe:{mode:'Sandbox',voiceModeMatches:true}},recipient:{state:'unknown'},catalogue:{state:'read',products:[{sku:'com.ayuhide.koenofurima.voice.jpy1000',amountJpy:1000,sandboxEnabled:true,productionEnabled:false}]}});
 }

 if(url.pathname.includes('/supabase-js@2.119.0/'))return reply(sdk,'application/javascript');
 if(url.pathname==='/auth/v1/token')return scenario==='wrong-password'?reply({code:'invalid_credentials',msg:'Invalid login credentials'},'application/json',400):reply(session());
 if(url.pathname==='/auth/v1/user')return reply(user());
 if(url.hostname!=='tyulybijubckitybgubc.supabase.co')return reply({error:'Unexpected destination'},'application/json',403);
 if(url.pathname==='/rest/v1/rpc/seller_finance_summary')return reply({count:0,payout:0,unverified:0,test:0,adjusting:0});
 if(url.pathname==='/rest/v1/rpc/pending_trade_summary')return reply({total:0});
 if(url.pathname==='/rest/v1/rpc/list_pending_trades')return reply({rows:[],hasMore:false});
 if(url.pathname==='/rest/v1/rpc/search_my_trades'||url.pathname==='/rest/v1/rpc/search_listings')return reply({rows:[],total:0});
 if(url.pathname==='/rest/v1/rpc/admin_support_inquiries')return reply({rows:[],has_more:false});
 if(url.pathname.startsWith('/rest/v1/')&&['GET','HEAD'].includes(r.method()))return reply(url.pathname.endsWith('/profiles')&&r.headers().accept?.includes('object')?{id:owner,display_name:'Synthetic QA'}:[]);
 if(url.pathname==='/functions/v1/stripe-account-status')return reply({verified:false});
 return reply({error:'Unexpected mutation or endpoint'},'application/json',403);
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
 await page.goto('http://qa.local/');await page.waitForFunction(()=>!authInitRunning);
 if(scenario!=='existing-session'){await page.locator('#email').fill('synthetic@example.invalid');await page.locator('#password').fill('synthetic-password');await page.getByRole('button',{name:'ログイン',exact:true}).click();}
 if(scenario==='wrong-password'){await page.waitForFunction(()=>document.getElementById('authMsg').textContent.includes('Invalid'));assert(await page.locator('#authPage').isVisible());}
 else{await page.waitForFunction(()=>currentUser?.id==='6454e07c-ed0b-46b7-a8a1-aa63c555d634'&&document.getElementById('home').classList.contains('on'));assert(await page.locator('#nav').isVisible());assert.equal(await page.evaluate(()=>isVoiceFleaAdmin()),true);
 for(const id of ['home','voices','sell','jobs','messages','me','home']){await page.evaluate(id=>go(id),id);assert(await page.locator('#'+id).isVisible(),id+' visible');}
 await page.locator('#sellTitle').fill('Unsent synthetic draft');await page.evaluate(()=>go('sell'));await page.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));window.dispatchEvent(new Event('focus'))});assert.equal(await page.locator('#sellTitle').inputValue(),'Unsent synthetic draft');
 await page.evaluate(()=>go('home'));
 assert(!requests.some(r=>r.url.includes('/functions/v1/iap-readiness')),'diagnostic never autoloads');
 await page.getByRole('button',{name:'購入設定の診断（読取専用）',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('iapReadinessResult').textContent.includes('取得済み・環境/JPY価格一致'));
 assert.equal(await page.locator('#iapReadinessOverlay').isVisible(),true);
 assert((await page.locator('#iapReadinessResult').textContent()).includes('明示設定なし・要確認'));
 await page.screenshot({path:path.join(__dirname,'integrated44-diagnostic-'+scenario+'.png'),fullPage:true});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#iapReadinessOverlay').isVisible(),false);
 assert.equal(await page.locator('#iapReadinessResult').textContent(),'');
 diagnosticUnavailable=true;
 await page.getByRole('button',{name:'購入設定の診断（読取専用）',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('iapReadinessResult').textContent.includes('未配備'));
 assert.equal(await page.evaluate(()=>window.__nativeCalls.length),1,'unavailable diagnostic must not call native products');
 await page.locator('#iapReadinessOverlay button').click();
 await page.screenshot({path:path.join(__dirname,'integrated44-home-'+scenario+'.png'),fullPage:true});
 await page.reload();await page.waitForFunction(()=>!authInitRunning&&currentUser?.id==='6454e07c-ed0b-46b7-a8a1-aa63c555d634');assert(await page.locator('#nav').isVisible());
 }
 assert.deepEqual(await page.evaluate(keys=>Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)])),Object.keys(seeded)),seeded);
 assert(!requests.some(r=>r.url.includes('neotkrfsquysuatdruhg')));
 assert(!requests.some(r=>/voice-iap|boost-iap|open_paid_purchase_conversation|create-checkout|apple-financial/.test(r.url)));
 assert((await page.evaluate(()=>window.__nativeCalls)).every(x=>x==='products'));assert.equal(errors.length,0,errors.join('\n'));
 results.push({scenario,passed:true,normalNavigation:scenario!=='wrong-password',oldStorageUnchanged:true,nativeJournalAccesses:0,requests,errors});await context.close();
}fs.writeFileSync(path.join(__dirname,'integrated44-browser-report.json'),JSON.stringify({localOnly:true,allNetworkIntercepted:true,webSha256:crypto.createHash('sha256').update(html).digest('hex'),results},null,2));console.log(JSON.stringify(results.map(({requests,...rest})=>({...rest,requestCount:requests.length})),null,2));}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
