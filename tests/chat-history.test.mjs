import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('async function fetchChatHistory('),html.indexOf('async function loadOlderChatMessages('));
const rows=Array.from({length:1201},(_,i)=>({id:`00000000-0000-0000-0000-${String(1201-i).padStart(12,'0')}`,created_at:'2026-10-20T00:00:00+00:00'}));
function setup({fail=0,insert=false}={}){
 let calls=0,records=[...rows];
 const sb={from(){let size,filter;const q={select(){return q},in(){return q},order(){return q},limit(n){size=n;return q},or(f){filter=f;return q},then(resolve){calls++;if(insert&&calls===2)records.unshift({...rows[0],id:'00000000-0000-0000-0000-999999999999'});const id=filter?.match(/id.lt.([^)]*)/)[1];return Promise.resolve(resolve(calls===fail?{error:Error('offline')}:{data:records.filter(r=>!id||r.id<id).slice(0,size)}))}};return q}};
 const context=vm.createContext({sb});vm.runInContext(source,context);return {fetch:context.fetchChatHistory,calls:()=>calls};
}
test('loads beyond 500 without gaps when timestamps tie',async()=>{const s=setup();const r=await s.fetch(['conversation'],1000,()=>true);assert.equal(r.messages.length,1000);assert.equal(new Set(r.messages.map(x=>x.id)).size,1000);assert.equal(r.messages[0].id,rows[999].id);assert.equal(r.hasMore,true)});
test('last page has no load-more affordance',async()=>{const r=await setup().fetch([],1500,()=>true);assert.equal(r.messages.length,1201);assert.equal(r.hasMore,false)});
test('new arrivals do not shift the older cursor and duplicate rows',async()=>{const r=await setup({insert:true}).fetch([],1000,()=>true);assert.equal(r.messages.length,1000);assert.equal(new Set(r.messages.map(x=>x.id)).size,1000);assert.equal(r.messages[0].id,rows[999].id)});
test('conversation switch stops obsolete pagination',async()=>{const s=setup();assert.equal(await s.fetch([],1000,()=>false),null);assert.equal(s.calls(),1)});
test('partial network failure never returns incomplete history as success',async()=>{await assert.rejects(setup({fail:2}).fetch([],1000,()=>true),/offline/)});
