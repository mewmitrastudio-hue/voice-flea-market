import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
function setup(responses){
 const calls=[];
 const c={currentUser:{id:'buyer'},jobList:{innerHTML:''},jobBadge:{textContent:'7',classList:{toggle(){}}},console:{warn(){}},esc:String,inlineText:String,financeYen:String,statusLabel:String,loadMessageBadge(){},loadNotificationBadge(){}};
 c.sb={from(table){const q={select(){return q},eq(...args){calls.push([table,...args]);return q},in(){return q},order(){return q},limit(){return q},then(a,b){const value=responses.shift();return Promise.resolve(value instanceof Error?Promise.reject(value):value).then(a,b)}};return q}};
 vm.createContext(c);
 const start=html.includes('let jobsLoadRequest=')?html.indexOf('let jobsLoadRequest='):html.indexOf('async function loadJobs(){');
 vm.runInContext(html.slice(start,html.indexOf('async function applyJob(')),c);
 const badgeStart=html.includes('let jobBadgeRequest=')?html.indexOf('let jobBadgeRequest='):html.indexOf('async function loadJobBadge(){');
 vm.runInContext(html.slice(badgeStart,html.indexOf('async function reviewApplication(')),c);
 return {c,calls};
}
const own={id:'job',title:'依頼',buyer_id:'buyer',budget_jpy:1500};
const other={...own,buyer_id:'seller'};
for(const role of ['buyer','seller'])test(`${role} application read errors never become empty or unapplied state`,async()=>{
 const {c}=setup([{data:[role==='buyer'?own:other]},{error:{message:'offline'}}]);
 await c.loadJobs();assert.match(c.jobList.innerHTML,/再読み込み/);assert.doesNotMatch(c.jobList.innerHTML,/まだ応募はありません|この声の依頼に応募/);
});
test('thrown network errors yield an accessible retry state',async()=>{
 const {c}=setup([new Error('offline')]);await c.loadJobs();assert.match(c.jobList.innerHTML,/role="alert"/);assert.match(c.jobList.innerHTML,/loadJobs\(\)/);
});
test('old jobs request cannot overwrite a newer response',async()=>{
 const pending=deferred();const {c}=setup([pending.promise,{data:[]}]);const old=c.loadJobs();await Promise.resolve();await c.loadJobs();const latest=c.jobList.innerHTML;pending.resolve({error:{message:'stale'}});await old;assert.equal(c.jobList.innerHTML,latest);assert.match(latest,/まだ募集がありません/);
});
test('account switch during jobs read stops later personal queries and stale rendering',async()=>{
 const pending=deferred();const {c,calls}=setup([pending.promise]);const old=c.loadJobs();await Promise.resolve();c.currentUser={id:'new-user'};c.jobList.innerHTML='new account';pending.resolve({data:[own]});await old;assert.equal(c.jobList.innerHTML,'new account');assert.ok(!calls.some(x=>x[0]==='applications'));
});
test('account switch during application read discards private application content',async()=>{
 const pending=deferred();const {c}=setup([{data:[own]},pending.promise]);const old=c.loadJobs();await new Promise(r=>setImmediate(r));c.currentUser=null;c.jobList.innerHTML='signed out';pending.resolve({data:[{job_id:'job',message:'private'}]});await old;assert.equal(c.jobList.innerHTML,'signed out');
});
test('badge count failure preserves last verified count',async()=>{
 const {c}=setup([{data:[own]},{error:{message:'offline'}}]);await c.loadJobBadge();assert.equal(c.jobBadge.textContent,'7');
});
test('old badge request cannot overwrite new count',async()=>{
 const pending=deferred();const {c}=setup([pending.promise,{data:[]}]);const old=c.loadJobBadge();await Promise.resolve();await c.loadJobBadge();pending.resolve({data:[own]});await old;assert.equal(c.jobBadge.textContent,'0');
});
test('account switch discards old badge count',async()=>{
 const pending=deferred();const {c}=setup([{data:[own]},pending.promise]);const old=c.loadJobBadge();await new Promise(r=>setImmediate(r));c.currentUser={id:'new'};pending.resolve({count:88});await old;assert.equal(c.jobBadge.textContent,'7');
});
