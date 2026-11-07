import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.split('\n').find(line=>line.startsWith('async function go(id,opts={})'));
function setup(overrides={}){
  const classes=initial=>{const values=new Set(initial);return {contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k),toggle(k,on){on?values.add(k):values.delete(k)}}};
  const pages=Object.fromEntries(['home','voices','sell','jobs','messages','me'].map(id=>[id,{id,scrollTop:27,classList:classes(id==='voices'?['on']:[])}]));
  const app={scrollTop:0};
  const context=vm.createContext({pageHistory:[],pageNavigationRequest:0,currentUser:null,selectedListingId:null,setShellMode(){},updateGlobalPageNav(){},loadListings:async()=>{},loadJobs:async()=>{},loadConversations:async()=>{},loadMe:async()=>{},window:{scrollTo(){}},document:{getElementById:id=>pages[id],querySelector:s=>s==='.app'?app:Object.values(pages).find(p=>p.classList.contains('on')),querySelectorAll:s=>s==='.page'?Object.values(pages):[]}});
  Object.assign(context,overrides);
  vm.runInContext(source,context);
  return {pages,go:context.go};
}
test('returning home resets the page scroller so the heading is visible',async()=>{const {pages,go}=setup();await go('home');assert.equal(pages.home.scrollTop,0)});
test('opening another page resets its own retained scroll',async()=>{const {pages,go}=setup();await go('sell');assert.equal(pages.sell.scrollTop,0)});
test('explicit keepScroll preserves the page position for in-place refresh',async()=>{const {pages,go}=setup();await go('home',{keepScroll:true});assert.equal(pages.home.scrollTop,27)});

test('a stalled listing load does not leave the new page scrolled down',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve});
 const {pages,go}=setup({loadListings:()=>pending});
 const loading=go('voices');assert.equal(pages.voices.scrollTop,0);
 finish();await loading;
});
test('an old page request cannot reset the scroll after navigating elsewhere',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve});let resets=0;
 const {pages,go}=setup({loadListings:()=>pending,window:{scrollTo(){resets++}}});
 const loading=go('voices');await go('home');pages.home.scrollTop=91;
 const expected=resets;finish();await loading;
 assert.equal(resets,expected);assert.equal(pages.home.scrollTop,91);
});
test('failed data loading still opens the page at its heading',async()=>{
 const {pages,go}=setup({loadJobs:async()=>{throw Error('offline')}});
 await assert.rejects(go('jobs'),/offline/);assert.equal(pages.jobs.scrollTop,0);
});
