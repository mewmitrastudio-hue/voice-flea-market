import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.split('\n').find(line=>line.startsWith('async function go(id,opts={})'));
function setup(){
  const classes=initial=>{const values=new Set(initial);return {contains:k=>values.has(k),add:k=>values.add(k),remove:k=>values.delete(k),toggle(k,on){on?values.add(k):values.delete(k)}}};
  const pages=Object.fromEntries(['home','voices','sell','jobs','messages','me'].map(id=>[id,{id,scrollTop:27,classList:classes(id==='voices'?['on']:[])}]));
  const app={scrollTop:0};
  const context=vm.createContext({pageHistory:[],currentUser:null,selectedListingId:null,setShellMode(){},updateGlobalPageNav(){},loadListings:async()=>{},loadJobs:async()=>{},loadConversations:async()=>{},loadMe:async()=>{},window:{scrollTo(){}},document:{getElementById:id=>pages[id],querySelector:s=>s==='.app'?app:Object.values(pages).find(p=>p.classList.contains('on')),querySelectorAll:s=>s==='.page'?Object.values(pages):[]}});
  vm.runInContext(source,context);
  return {pages,go:context.go};
}
test('returning home resets the page scroller so the heading is visible',async()=>{const {pages,go}=setup();await go('home');assert.equal(pages.home.scrollTop,0)});
test('opening another page resets its own retained scroll',async()=>{const {pages,go}=setup();await go('sell');assert.equal(pages.sell.scrollTop,0)});
test('explicit keepScroll preserves the page position for in-place refresh',async()=>{const {pages,go}=setup();await go('home',{keepScroll:true});assert.equal(pages.home.scrollTop,27)});
