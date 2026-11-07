import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const swift=fs.readFileSync(new URL('../BoostPlugin.swift',import.meta.url),'utf8');
const project='neotkrfsquysuatdruhg',prefix=`vf_scoped_${project}_`,authKey=`vf_recording_${project}_auth_v1`;
const owner='10000000-0000-4000-8000-000000000001',target='20000000-0000-4000-8000-000000000002';
const legacy=`vf_voice_attempt_${owner}:${target}`;
const config=()=>Object.freeze({ENVIRONMENT:'recording-sandbox',SUPABASE_URL:`https://${project}.supabase.co`,SUPABASE_PUBLISHABLE_KEY:'test-key',RECORDING_APPLE_PURCHASES_ENABLED:false,RECORDING_APPLE_RECOVERY_ENABLED:false,RECORDING_STRIPE_READS_ENABLED:false,RECORDING_STRIPE_WRITES_ENABLED:false});
const empty=()=>({purchaseBlocked:false,approvalPending:false,journalPresent:false,transactions:[],blockingKind:'',journalVersion:2,backendProjectRef:project,environment:'Sandbox',applePurchasesEnabled:false,appleRecoveryEnabled:false,stripeWritesEnabled:false});
const slice=(from,to)=>html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));
const functionCode=name=>{const start=html.indexOf('async function '+name+'(');assert.notEqual(start,-1);return html.slice(start,html.indexOf('\n}',start)+2)};
function harness(entries=[],options={}){
 const data=new Map(entries),reads=[],writes=[],removes=[];let nativeCalls=0;
 const storage={get length(){if(options.storageError)throw Error('storage denied');return data.size},key:i=>[...data.keys()][i]??null,getItem(k){reads.push(k);if(k===legacy||k.startsWith('vf_voice_attempt_'))throw Error('legacy value read forbidden');return data.get(k)??null},setItem(k,v){writes.push(k);data.set(k,String(v))},removeItem(k){removes.push(k);data.delete(k)}};
 const cfg=config(),window={VOICE_FLEA_CONFIG:cfg,localStorage:storage,Capacitor:{isNativePlatform:()=>true,getPlatform:()=>options.platform??'ios'}};
 const ctx=vm.createContext({cfg,window,atob:s=>Buffer.from(s,'base64').toString('binary'),console,alert(){},pageNavigationRequest:0,boostRead:fn=>fn(),nativeBoost:async()=>({plugin:{pendingTransactions:async()=>{nativeCalls++;if(options.nativeError)throw Error('native unavailable');if(options.onNative)await options.onNative({data,window});return options.pending===undefined?empty():options.pending}}})});
 vm.runInContext(slice('function recordingBackendMatches(',"function esc(s='')")+slice('const localStateCache=', 'const volatileUIState=')+slice('async function assertRecordingEnvironmentSafe(){','async function init(){'),ctx);
 return {ctx,data,reads,writes,removes,window,options,run:()=>ctx.assertRecordingEnvironmentSafe(),nativeCalls:()=>nativeCalls,eval:code=>vm.runInContext(code,ctx)};
}
test('voice-only legacy keys permit nonfinancial startup without reading or changing any legacy bytes',async()=>{
 const h=harness([[legacy,'opaque legacy bytes'],[`vf_voice_attempt_${owner}:job:${target}`,'other bytes']]);const before=[...h.data];await h.run();assert.equal(h.nativeCalls(),1);assert.deepEqual([...h.data],before);assert.deepEqual(h.reads,[authKey]);assert.deepEqual(h.writes,[]);assert.deepEqual(h.removes,[]);assert.equal(h.eval('recordingLegacyIsolationRequired'),true);assert.equal(h.eval('recordingApplePurchasesAllowed()||recordingAppleRecoveryAllowed()||recordingStripeReadsAllowed()||recordingStripeWritesAllowed()||recordingAccountDeletionAllowed()'),false);
});
for(const key of ['vf_pending_purchase_x','vf_checkout_attempt_x','vf_boost_attempt_x','vf_financial_resolution_pending_x','vf_message_attempt_x','vf_voice_attempt_invalid','vf_scoped_other_vf_voice_attempt_x'])test('mixed or malformed legacy blocks: '+key,async()=>{const h=harness([[legacy,'keep'],[key,'keep']]);await assert.rejects(h.run());assert.equal(h.nativeCalls(),0);assert.deepEqual(h.reads,[]);assert.equal(h.data.size,2)});
test('all app storage, drafts, cache and enumeration use captured namespace after config replacement',async()=>{
 const draft=`voice_flea_ui_${owner}_draft_chat`,hidden=`voice_flea_hidden_${owner}_chat`;
 const h=harness([[legacy,'keep'],[draft,'old secret'],[prefix+hidden,'1'],['vf_scoped_foreign_other','foreign']]);
 assert.equal(h.eval(`safeLocalStorage.getItem(${JSON.stringify(draft)})`),null);
 h.eval(`safeLocalStorage.setItem(${JSON.stringify(draft)},'new draft');safeLocalStorage.durableSetItem('vf_message_attempt_test','new attempt')`);
 h.window.VOICE_FLEA_CONFIG={ENVIRONMENT:'production'};
 assert.equal(h.eval(`safeLocalStorage.getItem(${JSON.stringify(draft)})`),'new draft');
 h.eval(`safeLocalStorage.removeItem(${JSON.stringify(draft)});safeLocalStorage.durableRemoveItem('vf_message_attempt_test')`);
 assert.equal(h.data.get(draft),'old secret');assert.equal(h.data.get(legacy),'keep');
 assert.deepEqual(Array.from(h.eval('safeLocalStorage.keys()')),[hidden]);assert.equal(h.eval('safeLocalStorage.length'),1);assert.equal(h.eval('safeLocalStorage.key(0)'),hidden);
 assert.equal(h.eval(`safeLocalStorage.getItem(${JSON.stringify(prefix+hidden)})`),'1');
 assert.throws(()=>h.eval("safeLocalStorage.getItem('vf_scoped_foreign_other')"));
 assert.ok([...h.reads,...h.writes,...h.removes].every(k=>k.startsWith(prefix)));
});
for(const options of [{storageError:true},{nativeError:true},{platform:'android'},{pending:null},...['backendProjectRef','environment','journalVersion','blockingKind','applePurchasesEnabled','appleRecoveryEnabled','stripeWritesEnabled'].map(key=>({pending:{...empty(),[key]:'unknown'}})),{pending:{...empty(),purchaseBlocked:true,journalPresent:true,blockingKind:'voice',approvalPending:true}}])test('legacy isolation rejects uncertain native/storage state '+JSON.stringify(options),async()=>{const h=harness([[legacy,'keep']],options);await assert.rejects(h.run());assert.equal(h.data.get(legacy),'keep');assert.deepEqual(h.writes,[]);assert.deepEqual(h.removes,[])});
test('retry after native failure rechecks native and preserves bytes',async()=>{const h=harness([[legacy,'keep']],{nativeError:true});await assert.rejects(h.run());h.options.nativeError=false;await h.run();assert.equal(h.nativeCalls(),2);assert.equal(h.data.get(legacy),'keep')});
test('native await rejects config replacement and new mixed legacy journal',async()=>{
 for(const onNative of [({window})=>{window.VOICE_FLEA_CONFIG=config()},({data})=>{data.set('vf_checkout_attempt_late','keep')}]){const h=harness([[legacy,'keep']],{onNative});await assert.rejects(h.run());assert.deepEqual(h.writes,[]);assert.deepEqual(h.removes,[])}
});
test('new legacy voice during native await cannot combine with pending native journal',async()=>{
 const h=harness([],{pending:{...empty(),purchaseBlocked:true,journalPresent:true,blockingKind:'voice',approvalPending:true},onNative:({data})=>{data.set(legacy,'late legacy')}});await assert.rejects(h.run());assert.equal(h.data.get(legacy),'late legacy');
});
test('fresh financial scans and latched isolation prevent payment after legacy disappears',async()=>{
 const h=harness();await h.run();h.data.set(legacy,'keep');assert.equal(h.eval('recordingFinancialStorageSafe()'),false);h.data.delete(legacy);assert.equal(h.eval('recordingFinancialStorageSafe()'),false);
 const clean=harness();await clean.run();clean.window.VOICE_FLEA_CONFIG=config();assert.equal(clean.eval('recordingFinancialStorageSafe()'),false);
});
function session(iss=`https://${project}.supabase.co/auth/v1`,sub=owner){return JSON.stringify({access_token:'header.'+Buffer.from(JSON.stringify({iss,aud:'authenticated',sub})).toString('base64url')+'.signature',refresh_token:'not-a-real-token',user:{id:owner}})}
test('auth uses explicit fresh key, URL detection off, old sessions untouched, exact issuer validation',async()=>{
 const old=`sb-${project}-auth-token`,h=harness([[old,'old-session'],['sb-other-auth-token','foreign'],[authKey,session()]]);await h.run();
 assert.equal(h.eval('recordingAuthOptions().auth.storageKey'),authKey);assert.equal(h.eval('recordingAuthOptions().auth.detectSessionInUrl'),false);assert.equal(h.eval('recordingAuthOptions().auth.storage===recordingAuthStorage'),true);assert.deepEqual(h.reads,[authKey]);assert.equal(h.data.get(old),'old-session');
 for(const value of [session('https://foreign.supabase.co/auth/v1'),session(undefined,target),'malformed']){const bad=harness([[authKey,value]]);await assert.rejects(bad.run());assert.equal(bad.data.get(authKey),value);assert.deepEqual(bad.removes,[])}
 assert.throws(()=>h.eval(`recordingAuthStorage.getItem(${JSON.stringify(old)})`));assert.throws(()=>h.eval(`recordingAuthStorage.setItem(${JSON.stringify(authKey)},${JSON.stringify(session('foreign'))})`));
});
test('direct financial helpers, account deletion and automatic reconciliation invoke nothing',async()=>{
 const h=harness([[legacy,'keep']]);await h.run();let external=0;const blocked=()=>{external++;throw Error('unexpected external call')};h.ctx.sb={functions:{invoke:blocked},auth:{getSession:blocked},rpc:blocked,from:blocked};h.ctx.confirm=blocked;h.ctx.prompt=blocked;
 for(const name of ['boostApi','voiceIapApi','appleManualEvidenceApi','requestAccountDeletion','reconcilePendingPurchase'])vm.runInContext(functionCode(name),h.ctx);
 for(const name of ['boostApi','voiceIapApi'])for(const action of ['prepare','prepareJob','verify','status','unknown'])await assert.rejects(h.ctx[name]({action}));
 await assert.rejects(h.ctx.appleManualEvidenceApi({},owner));await h.ctx.requestAccountDeletion();assert.equal(await h.ctx.reconcilePendingPurchase(),null);assert.equal(external,0);assert.equal(h.data.get(legacy),'keep');
});
test('native unknown products explicitly fail closed; original journal location and purchase locks retained',()=>{
 const native=swift.slice(swift.indexOf('@objc func pendingTransactions('),swift.indexOf('private func isRecordingTransaction'));
 assert.match(native,/guard isAllowed\(transaction\.productID\) else/);assert.ok(swift.includes('koe-purchase-attempt.json'));assert.ok(swift.includes('private let recordingApplePurchasesEnabled = false'));assert.ok(swift.includes('private let recordingAppleRecoveryEnabled = false'));
});
test('init creates client only after safety gate and passes isolated authentication options',()=>{
 const init=slice('async function init(){','async function renderAuth(){');assert.ok(init.indexOf('await assertRecordingEnvironmentSafe();')<init.indexOf('window.supabase.createClient'));assert.match(init,/createClient\(cfg\.SUPABASE_URL,cfg\.SUPABASE_PUBLISHABLE_KEY,recordingAuthOptions\(\)\)/);
});
function enableInit(h){
 let clients=0;const classes={add(){},remove(){}};
 Object.assign(h.ctx,{esc:String,authUIRevision:0,resetPrivateUI(){},configured:true,authInitRunning:false,authBootstrapping:false,recordingDiagnosticRevision:0,recordingDiagnosticBusy:false,cloudStatus:{textContent:'',classList:classes},configNotice:{classList:classes,innerHTML:''},sb:null,authSubscription:null,authEventRevision:0,currentUser:null,authReloadPending:false,handleAuthStateChange(){},renderAuth:async()=>{},document:{getElementById:()=>null},console:{error(){}}});
 h.window.__loadSupabaseSDK=async()=>true;
 h.window.supabase={createClient(url,key,options){clients++;assert.equal(url,config().SUPABASE_URL);assert.equal(options.auth.storageKey,authKey);assert.equal(options.auth.detectSessionInUrl,false);return {auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),getSession:async()=>({data:{session:null},error:null})}}}};
 vm.runInContext(slice('async function init(){','async function renderAuth(){'),h.ctx);
 return {run:()=>h.ctx.init(),clients:()=>clients};
}
test('actual init native failure creates zero clients; retry rechecks and creates isolated client once',async()=>{
 const h=harness([[legacy,'keep']],{nativeError:true}),init=enableInit(h);await init.run();assert.equal(init.clients(),0);assert.equal(h.ctx.authInitRunning,false);h.options.nativeError=false;await init.run();assert.equal(init.clients(),1);assert.equal(h.nativeCalls(),2);await init.run();assert.equal(init.clients(),1);assert.equal(h.nativeCalls(),3);assert.equal(h.data.get(legacy),'keep');
});
test('actual init rejects late config change and foreign auth value without constructing a client',async()=>{
 for(const onNative of [({window})=>{window.VOICE_FLEA_CONFIG=config()},({data})=>{data.set(authKey,session('foreign'))}]){const h=harness([[legacy,'keep']],{onNative}),init=enableInit(h);await init.run();assert.equal(init.clients(),0);assert.equal(h.ctx.sb,null);assert.equal(h.ctx.authInitRunning,false);assert.equal(h.data.get(legacy),'keep');}
});
test('legacy only remains disallowed whenever any financial flag is enabled or malformed',async()=>{
 for(const flag of ['RECORDING_APPLE_PURCHASES_ENABLED','RECORDING_APPLE_RECOVERY_ENABLED','RECORDING_STRIPE_READS_ENABLED','RECORDING_STRIPE_WRITES_ENABLED'])for(const value of [true,undefined,'false']){const h=harness([[legacy,'keep']]);const cfg={...config(),[flag]:value};h.ctx.cfg=cfg;h.window.VOICE_FLEA_CONFIG=cfg;await assert.rejects(h.run());assert.equal(h.data.get(legacy),'keep');assert.deepEqual(h.reads,[]);}
});
test('same-object config mutation during native await fails closed',async()=>{
 const h=harness([[legacy,'keep']],{onNative:({window})=>{window.VOICE_FLEA_CONFIG.SUPABASE_PUBLISHABLE_KEY='changed'}});const mutable={...config()};h.ctx.cfg=mutable;h.window.VOICE_FLEA_CONFIG=mutable;await assert.rejects(h.run());assert.equal(h.data.get(legacy),'keep');
});
test('failed retry invalidates existing client without signing out or clearing storage',async()=>{
 const h=harness([[legacy,'keep']]),init=enableInit(h);await init.run();assert.equal(init.clients(),1);let stopped=0,reset=0;h.ctx.sb.auth.stopAutoRefresh=()=>stopped++;h.ctx.sb.auth.signOut=()=>assert.fail('must not sign out');h.ctx.resetPrivateUI=()=>reset++;h.options.nativeError=true;await init.run();assert.equal(h.ctx.sb,null);assert.equal(h.ctx.currentUser,null);assert.equal(stopped,1);assert.equal(reset,1);assert.equal(h.data.get(legacy),'keep');assert.deepEqual(h.removes,[]);
});
test('config change during session await invalidates client before rendering',async()=>{
 const h=harness([[legacy,'keep']]),init=enableInit(h);await init.run();let rendered=0,stopped=0;h.ctx.renderAuth=async()=>rendered++;h.ctx.sb.auth.stopAutoRefresh=()=>stopped++;h.ctx.sb.auth.getSession=async()=>{h.window.VOICE_FLEA_CONFIG=config();return {data:{session:{user:{id:owner}}},error:null}};await init.run();assert.equal(h.ctx.sb,null);assert.equal(h.ctx.currentUser,null);assert.equal(stopped,1);assert.equal(rendered,0);assert.deepEqual(h.removes,[]);
});
for(const delta of [{blockingKind:'',approvalPending:true,transactions:[]},{blockingKind:'voice',approvalPending:true,transactions:[{transactionId:'123'}]},{blockingKind:'voice',approvalPending:false,transactions:[]}])test('unfiltered native contradictory blocked metadata fails closed without legacy '+JSON.stringify(delta),async()=>{
 const h=harness([],{pending:{...empty(),purchaseBlocked:true,journalPresent:true,...delta}});await assert.rejects(h.run());assert.deepEqual(h.writes,[]);assert.deepEqual(h.removes,[]);
});
test('volatile UI state and account switching never load an old unscoped draft',()=>{
 const draft=`voice_flea_ui_${owner}_draft_chat`,h=harness([[draft,'old private draft']]);h.ctx.currentUser={id:owner};vm.runInContext("function uiKey(name){return `voice_flea_ui_${currentUser?.id||'guest'}_${name}`}"+slice('const volatileUIState=','function clearChatNotice()'),h.ctx);
 assert.equal(h.eval("readUIState('draft_chat')"),null);h.eval("writeUIState('draft_chat','recording draft')");assert.equal(h.eval("readUIState('draft_chat')"),'recording draft');h.ctx.currentUser={id:target};assert.equal(h.eval("readUIState('draft_chat')"),null);h.ctx.currentUser={id:owner};h.eval("removeUIState('draft_chat')");assert.equal(h.eval("readUIState('draft_chat')"),null);assert.equal(h.data.get(draft),'old private draft');assert.ok([...h.reads,...h.writes,...h.removes].every(k=>k.startsWith(prefix)));
});
