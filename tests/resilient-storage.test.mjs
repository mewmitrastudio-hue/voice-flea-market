import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('const localStateCache='),html.indexOf('const volatileUIState='));
function setup(storage){const context=vm.createContext({window:{get localStorage(){if(storage instanceof Error)throw storage;return storage}}});vm.runInContext(source+';globalThis.store=safeLocalStorage',context);return context.store;}
test('denied storage still supports set, read and removal',()=>{const s=setup(new Error('denied'));assert.equal(s.getItem('key'),null);s.setItem('key',17);assert.equal(s.getItem('key'),'17');assert.equal(s.length,1);assert.equal(s.key(0),'key');s.removeItem('key');assert.equal(s.getItem('key'),null);assert.equal(s.length,0)});
test('quota failure never restores stale disk flags',()=>{const s=setup({getItem:()=> 'old',setItem(){throw Error('quota')},removeItem(){throw Error('denied')},length:1,key:()=> 'key'});s.setItem('key','new');assert.equal(s.getItem('key'),'new');s.removeItem('key');assert.equal(s.getItem('key'),null);assert.equal(s.length,0)});
test('available disk preserves existing values and forwards mutations',()=>{const data=new Map([['existing','value']]);const s=setup({getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),get length(){return data.size},key:i=>[...data.keys()][i]??null});assert.equal(s.getItem('existing'),'value');s.setItem('new',3);assert.equal(data.get('new'),'3');assert.equal(s.length,2);s.removeItem('existing');assert.equal(data.has('existing'),false);assert.equal(s.length,1)});
test('storage denial while enumerating does not lose memory keys',()=>{const s=setup({getItem(){throw Error('denied')},setItem(){throw Error('denied')},removeItem(){throw Error('denied')},get length(){throw Error('denied')}});s.setItem('userA','a');s.setItem('userB','b');s.removeItem('userA');assert.equal(s.length,1);assert.equal(s.key(0),'userB');assert.equal(s.key(8),null)});
test('all app access uses the resilient facade; Auth SDK is unchanged',()=>{const outside=html.replace(source,'');assert.doesNotMatch(outside,/(?<!safeLocalStorage\.)\blocalStorage\./);assert.match(html,/window\.supabase\.createClient\(cfg.SUPABASE_URL,cfg.SUPABASE_PUBLISHABLE_KEY\)/)});
