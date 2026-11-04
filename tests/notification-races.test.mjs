import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function setup(){
 const requests=[],writes=[],alerts=[];const classes=new Set();
 const c=vm.createContext({currentUser:{id:'A'},notifOverlay:{classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)}},notifContent:{textContent:'',innerHTML:''},getNotificationData:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),esc:String,safeLocalStorage:{setItem:(...x)=>writes.push(x)},loadNotificationBadge(){},alert:x=>alerts.push(x)});
 vm.runInContext(html.slice(html.indexOf('function notifTypeClass('),html.indexOf("let safetyMode=")),c);
 const result=title=>({items:[{title,kind:'応募',target:'jobs',seenKey:'key',unread:true}]});
 return {c,requests,writes,alerts,classes,result};
}
test('a slower old notification request cannot replace newer contents',async()=>{const {c,requests,result}=setup();const first=c.openNotifications(),second=c.openNotifications();requests[1].resolve(result('new'));await second;requests[0].resolve(result('old'));await first;assert.match(c.notifContent.innerHTML,/new/);assert.doesNotMatch(c.notifContent.innerHTML,/old/)});
test('a stale notification failure cannot replace newer successful contents',async()=>{const {c,requests,result}=setup();const first=c.openNotifications(),second=c.openNotifications();requests[1].resolve(result('new'));await second;requests[0].reject(Error('offline'));await first;assert.equal(c.notifContent.textContent,'読み込み中...');assert.match(c.notifContent.innerHTML,/new/)});
test('closing notifications while marking read never reopens them',async()=>{const {c,requests,result,classes,writes}=setup();const open=c.openNotifications();requests[0].resolve(result('message'));await open;const pending=c.markAllNotificationsRead();c.closeNotifications();requests[1].resolve(result('message'));await pending;assert.equal(classes.has('on'),false);assert.equal(requests.length,2);assert.equal(writes.length,1)});

test('closing and reopening invalidates the previous response',async()=>{const {c,requests,result}=setup();const first=c.openNotifications();c.closeNotifications();const second=c.openNotifications();requests[1].resolve(result('reopened'));await second;requests[0].resolve(result('closed'));await first;assert.match(c.notifContent.innerHTML,/reopened/);assert.doesNotMatch(c.notifContent.innerHTML,/closed/)});
test('account switching suppresses an earlier account notification result',async()=>{const {c,requests,result}=setup();const pending=c.openNotifications();c.currentUser={id:'B'};requests[0].resolve(result('private A'));await pending;assert.doesNotMatch(c.notifContent.innerHTML,/private A/)});
