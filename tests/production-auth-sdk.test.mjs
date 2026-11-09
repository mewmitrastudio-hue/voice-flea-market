import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const sdk=fs.readFileSync(new URL('./fixtures/vendor/supabase-js-2.119.0.umd.js',import.meta.url),'utf8');
const project='https://tyulybijubckitybgubc.supabase.co',key='sb-tyulybijubckitybgubc-auth-token';
const owner='6454e07c-ed0b-46b7-a8a1-aa63c555d634',other='44444444-4444-4444-8444-444444444444';
function session(){const exp=Math.floor(Date.now()/1000)+7200;return {access_token:[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify({iss:project+'/auth/v1',sub:owner,aud:'authenticated',exp})).toString('base64url'),'synthetic'].join('.'),refresh_token:'synthetic-refresh',token_type:'bearer',expires_in:7200,expires_at:exp,user:{id:owner,email:'unit@example.invalid'}}}
function fixture(existing=false,badPassword=false){
 const old=[['vf_recording_neotkrfsquysuatdruhg_auth_v1','recording-session'],['sb-neotkrfsquysuatdruhg-auth-token','old-recording-session'],['vf_voice_attempt_'+other+':listing','unknown exact pending bytes'],['vf_pending_purchase_'+owner,'corrupt old purchase bytes'],['voice_flea_ui_'+other+'_draft_chat','old draft']];
 const data=new Map(old);if(existing)data.set(key,JSON.stringify(session()));const calls=[],network=[],clients=[];
 const storage={get length(){return data.size},key:i=>[...data.keys()][i]??null,getItem:k=>{calls.push(['get',k]);return data.get(k)??null},setItem(k,v){calls.push(['set',k]);data.set(k,v)},removeItem(k){calls.push(['remove',k]);data.delete(k)}};
 const location={href:'http://qa.local/',hash:'',search:'',pathname:'/'};
 const context=vm.createContext({console,URL,URLSearchParams,setTimeout,clearTimeout,setInterval,clearInterval,atob,Request,Response,Headers,TextEncoder,TextDecoder,AbortController,WebSocket:globalThis.WebSocket,localStorage:storage,location,window:{localStorage:storage,location,addEventListener(){},removeEventListener(){}},document:{visibilityState:'hidden',addEventListener(){},removeEventListener(){}},fetch:async(url,options={})=>{const r=url instanceof Request?url:new Request(url,options);network.push(r.url);if(r.url===project+'/auth/v1/token?grant_type=password')return new Response(JSON.stringify(badPassword?{code:'invalid_credentials',msg:'Invalid login credentials'}:session()),{status:badPassword?400:200});if(r.url===project+'/auth/v1/user')return new Response(JSON.stringify(session().user),{status:200});throw Error('Unexpected request: '+r.url)}});
 vm.runInContext(sdk,context);
 const make=()=>{const c=vm.runInContext(`supabase.createClient('${project}','synthetic-publishable')`,context);clients.push(c);return c};
 return {context,data,calls,network,make,check(){for(const[k,v]of old){assert.equal(data.get(k),v);assert(!calls.some(([,t])=>t===k),'unrelated old key accessed')}} ,async stop(){for(const c of clients)await c.auth.stopAutoRefresh()}};
}
test('production runtime pins official SDK bytes used in actual Auth tests',()=>{
 assert.equal((html.match(/@supabase\/supabase-js@2\.119\.0\/dist\/umd\/supabase.min.js/g)||[]).length,2);
 assert.equal(createHash('sha256').update(sdk).digest('hex'),fs.readFileSync(new URL('./fixtures/vendor/supabase-js-2.119.0.sha256',import.meta.url),'utf8').trim());
});
test('actual SDK resumes the original normal-app session without reading recording auth or purchase records',async()=>{
 const h=fixture(true);try{const c=h.make(),r=await c.auth.getSession();assert.equal(r.error,null);assert.equal(r.data.session.user.id,owner);assert.deepEqual(h.network,[]);h.check();}finally{await h.stop()}
});
test('actual SDK password login and new-client restoration use original backend and original auth key',async()=>{
 const h=fixture();try{const c=h.make();assert.equal((await c.auth.getSession()).data.session,null);const r=await c.auth.signInWithPassword({email:'unit@example.invalid',password:'synthetic-password'});assert.equal(r.error,null);assert.equal(r.data.user.id,owner);assert(h.data.has(key));await c.auth.stopAutoRefresh();const again=h.make();assert.equal((await again.auth.getSession()).data.session.user.id,owner);assert.deepEqual(h.network,[project+'/auth/v1/token?grant_type=password']);h.check();}finally{await h.stop()}
});
test('actual SDK rejected password remains unsigned in and preserves other sessions and purchase records',async()=>{
 const h=fixture(false,true);try{const c=h.make();await c.auth.getSession();const r=await c.auth.signInWithPassword({email:'unit@example.invalid',password:'synthetic-password'});assert.equal(r.error.status,400);assert.match(r.error.message,/Invalid login credentials/);assert.equal((await c.auth.getSession()).data.session,null);assert(!h.data.has(key));h.check();}finally{await h.stop()}
});
