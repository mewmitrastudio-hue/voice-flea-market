import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const sdk=fs.readFileSync(new URL('./fixtures/vendor/supabase-js-2.119.0.umd.js',import.meta.url),'utf8');
const adapter=html.slice(html.indexOf('const localStateCache='),html.indexOf('const volatileUIState='));
const project='https://neotkrfsquysuatdruhg.supabase.co',key='vf_recording_neotkrfsquysuatdruhg_auth_v1';
const owner='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002';
const legacy='vf_voice_attempt_'+owner+':'+target;
function token({issuer=project+'/auth/v1',sub=owner,expires=3600}={}){return [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({iss:issuer,sub,aud:'authenticated',exp:Math.floor(Date.now()/1000)+expires})).toString('base64url'),'synthetic-signature'].join('.')}
function session({expires=3600,...rest}={}){return {access_token:token({expires,...rest}),refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:expires,expires_at:Math.floor(Date.now()/1000)+expires,user:{id:owner,email:'unit@example.invalid'}}}
function fixture({entries=[],browser=false,hash='',query=''}={}){
 const old=[['sb-originalproject-auth-token','original-session'],['sb-neotkrfsquysuatdruhg-auth-token','previous-default-recording-session'],[legacy,'unchanged-legacy-attempt'],['voice_flea_ui_'+owner+'_draft_'+target,'original-draft']];
 const data=new Map([...old,...entries]),calls=[],network=[];const clients=[];
 const storage={get length(){return data.size},key:i=>[...data.keys()][i]??null,getItem:k=>{calls.push(['get',k]);return data.get(k)??null},setItem(k,v){calls.push(['set',k]);data.set(k,v)},removeItem(k){calls.push(['remove',k]);data.delete(k)}};
 const location={href:'https://recording.invalid/'+query+hash,hash,search:query,pathname:'/'};
 const window={VOICE_FLEA_CONFIG:{ENVIRONMENT:'recording-sandbox'},localStorage:storage,location,addEventListener(){},removeEventListener(){}};
 const ctx=vm.createContext({console,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,atob,Request,Response,Headers,TextEncoder,TextDecoder,AbortController,WebSocket:globalThis.WebSocket,window,location,
  ...(browser?{document:{visibilityState:'hidden',addEventListener(){},removeEventListener(){}}}:{}),
  fetch:async(url,options={})=>{
   url=String(url);network.push({url,method:options.method,body:options.body});
   if(url===project+'/auth/v1/token?grant_type=password'||url===project+'/auth/v1/token?grant_type=refresh_token')return new Response(JSON.stringify(session()),{status:200});
   if(url===project+'/auth/v1/logout?scope=global')return new Response(null,{status:204});
   throw Error('Unexpected mocked-network request: '+url);
  }});
 vm.runInContext(adapter,ctx);vm.runInContext(sdk,ctx);
 const make=()=>{const c=vm.runInContext(`supabase.createClient('${project}','synthetic-publishable',recordingAuthOptions())`,ctx);clients.push(c);return c};
 const check=()=>{for(const [k,v] of old){assert.equal(data.get(k),v);assert.ok(calls.every(([,t])=>t!==k),'old key accessed: '+k)}};
 return {data,calls,network,ctx,make,check,stop:async()=>{for(const c of clients)await c.auth.stopAutoRefresh()}};
}
test('runtime pins both fallback CDNs to the actual tested official Supabase SDK',()=>{
 assert.match(sdk,/supabase-js@2\.119\.0/);
 assert.equal((html.match(/@supabase\/supabase-js@2\.119\.0\/dist\/umd\/supabase.min.js/g)||[]).length,2);
 assert.doesNotMatch(html,/@supabase\/supabase-js@2\//);
 // Complete downloaded UMD bytes, rather than a synthetic SDK facade.
 assert.ok(sdk.length>200000);assert.equal(createHash('sha256').update(sdk).digest('hex'),fs.readFileSync(new URL('./fixtures/vendor/supabase-js-2.119.0.sha256',import.meta.url),'utf8').trim());
});
test('real SDK password login, persistence, new-client getSession and signOut preserve every legacy key',async()=>{
 const h=fixture();try{
  const a=h.make();assert.equal((await a.auth.getSession()).data.session,null);
  const signed=await a.auth.signInWithPassword({email:'unit@example.invalid',password:'synthetic-password'});assert.equal(signed.error,null);assert.equal(signed.data.user.id,owner);assert.ok(h.data.has(key));
  await a.auth.stopAutoRefresh();const b=h.make();assert.equal((await b.auth.getSession()).data.session.user.id,owner);
  const flow='0123456789abcdef0123456789abcdef';h.data.set(key+'-flows-code-verifier',JSON.stringify([flow]));h.data.set(key+'-flow-'+flow+'-code-verifier',JSON.stringify('synthetic-code'));h.data.set(key+'-code-verifier',JSON.stringify('synthetic-code'));h.data.set(key+'-user',JSON.stringify({user:{id:owner}}));
  assert.equal((await b.auth.signOut()).error,null);assert.equal((await b.auth.getSession()).data.session,null);
  for(const suffix of ['','-user','-code-verifier','-flows-code-verifier','-flow-'+flow+'-code-verifier'])assert.equal(h.data.has(key+suffix),false);
  assert.deepEqual(h.network.map(x=>x.url),[project+'/auth/v1/token?grant_type=password',project+'/auth/v1/logout?scope=global']);h.check();
 }finally{await h.stop()}
});
test('real SDK refresh uses only the new namespace and persists its returned session',async()=>{
 const h=fixture({entries:[[key,JSON.stringify(session({expires:-60}))]]});try{
  const c=h.make(),r=await c.auth.getSession();assert.equal(r.error,null);assert.equal(r.data.session.user.id,owner);assert.ok(r.data.session.expires_at>Date.now()/1000);
  assert.equal(h.network.length,1);assert.equal(h.network[0].url,project+'/auth/v1/token?grant_type=refresh_token');assert.equal(JSON.parse(h.network[0].body).refresh_token,'synthetic-refresh');h.check();
 }finally{await h.stop()}
});
for(const mode of ['fragment','code'])test('real browser-mode SDK ignores foreign '+mode+' login return without requests or mutations',async()=>{
 const hash=mode==='fragment'?'#access_token='+token({issuer:'https://foreign.invalid/auth/v1'})+'&refresh_token=foreign-secret&token_type=bearer&expires_in=3600':'';
 const h=fixture({browser:true,hash,query:mode==='code'?'?code=foreign-code':''});try{
  const c=h.make(),r=await c.auth.getSession();assert.equal(r.error,null);assert.equal(r.data.session,null);assert.deepEqual(h.network,[]);assert.equal(h.data.has(key),false);h.check();assert.equal(h.ctx.window.location.hash,hash);
 }finally{await h.stop()}
});
test('adapter rejects foreign prefixes and unsupported suffixes before any physical storage call',()=>{
 const h=fixture();for(const k of ['sb-originalproject-auth-token',key+'evil',key+'-unknown',key+'-flow-../escape-code-verifier']){
  const before=h.calls.length;h.ctx.badKey=k;for(const action of ["recordingAuthStorage.getItem(badKey)","recordingAuthStorage.setItem(badKey,'x')","recordingAuthStorage.removeItem(badKey)"])assert.throws(()=>vm.runInContext(action,h.ctx),/認証の保存先/);assert.equal(h.calls.length,before);
 }h.check();
});
