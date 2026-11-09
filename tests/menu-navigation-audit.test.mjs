import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const menu=html.slice(html.indexOf('<div id="mainMenuOverlay"'),html.indexOf('<div id="adminDashboardOverlay"'));
test('every menu action references an existing function and every section target exists',()=>{
 let controls=0;
 for(const match of menu.matchAll(/onclick="([^"]+)"/g)){
  for(const call of match[1].matchAll(/\b([a-zA-Z_$][\w$]*)\(/g)){
   if(call[1]==='if')continue;
   assert.match(html,new RegExp('function '+call[1]+'\\('),call[1]);
  }
  controls++;
 }
 assert.ok(controls>=30,`Only ${controls} menu controls checked`);
 for(const target of menu.matchAll(/menuGo(?:MySection)?\('([^']+)'\)/g))assert.ok(html.includes(`id="${target[1]}"`),target[1]);
});
function sectionSetup(){
 const timers=[],scrolls=[],pending=[];let page='me';
 const c=vm.createContext({currentUser:{id:'buyer'},closeMainMenu(){},markMyListingsSeen(){},go:()=>new Promise(resolve=>pending.push(resolve)),setTimeout:f=>timers.push(f),document:{querySelector:()=>({id:page}),getElementById:id=>({scrollIntoView:()=>scrolls.push(id)})}});
 vm.runInContext(html.slice(html.indexOf('let mySectionRequest='),html.indexOf('let pageHistory=')),c);
 return {c,timers,scrolls,pending,page:id=>page=id};
}
test('slow section navigation cannot scroll after leaving my page',async()=>{const s=sectionSetup();const p=s.c.menuGoMySection('myListings');s.pending[0]();await p;s.page('home');s.timers[0]();assert.deepEqual(s.scrolls,[])});
test('only latest requested section scrolls after out-of-order completion',async()=>{const s=sectionSetup();const a=s.c.menuGoMySection('myListings'),b=s.c.menuGoMySection('myPurchasedVoices');s.pending[1]();await b;s.pending[0]();await a;s.timers.forEach(f=>f());assert.deepEqual(s.scrolls,['myPurchasedVoices'])});
test('account switch cancels a delayed section scroll',async()=>{const s=sectionSetup();const p=s.c.menuGoMySection('myListings');s.pending[0]();await p;s.c.currentUser={id:'other'};s.timers[0]();assert.deepEqual(s.scrolls,[])});
