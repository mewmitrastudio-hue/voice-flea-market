import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const element=value=>({value,disabled:false,textContent:'運営へ送信'});
function fixture(){
 const nodes={publicSupportSubmit:element(''),publicSupportEmail:element('reader@example.com'),
  publicSupportDetail:element('Original question'),safetySubmit:element(''),
  safetyCategory:element('fraud'),safetyDetail:element('Original report')};
 const response=Promise.withResolvers(),writes=[],notices=[];
 const context={currentUser:{id:'buyer'},authReloadPending:false,safetyMode:'chat',safetyRequest:1,
  safetyTargetUserId:'seller',safetyConversationId:'original-trade',currentConversationId:'newer-trade',
  document:{getElementById:id=>nodes[id]},info:(...args)=>notices.push(args),
  sb:{from:table=>({insert:payload=>{writes.push({table,payload});return response.promise;}})},
 };
 vm.createContext(context);
 vm.runInContext(html.slice(html.indexOf('async function sendSupportForm('),html.indexOf('function uiKey('))+
  html.slice(html.indexOf('async function submitSafetyRequest('),html.indexOf('async function refreshAllData(')),context);
 return {context,nodes,response,writes,notices};
}

test('public support submits once and keeps text edited while waiting',async()=>{
 const f=fixture();
 const first=f.context.submitPublicSupportRequest();
 await f.context.submitPublicSupportRequest();
 assert.equal(f.writes.length,1);
 assert.equal(f.nodes.publicSupportSubmit.textContent,'送信中…');
 f.nodes.publicSupportDetail.value='A new draft';
 f.response.resolve({error:null});
 await first;
 assert.equal(f.nodes.publicSupportDetail.value,'A new draft');
 assert.match(f.notices.at(-1)[1],/受け付けました.*残しています/);
 assert.equal(f.nodes.publicSupportSubmit.disabled,false);
});

test('a failed public submission keeps its draft and avoids exposing the server error',async()=>{
 const f=fixture();
 const first=f.context.submitPublicSupportRequest();
 f.response.reject(new Error('private server details'));
 await first;
 assert.equal(f.nodes.publicSupportDetail.value,'Original question');
 assert.match(f.notices.at(-1)[1],/入力内容を残しています/);
 assert.doesNotMatch(f.notices.at(-1)[1],/private/);
 assert.equal(f.nodes.publicSupportSubmit.disabled,false);
});

test('a report is sent once for the original trade and does not overwrite a reopened form',async()=>{
 const f=fixture();
 const first=f.context.submitSafetyRequest();
 await f.context.submitSafetyRequest();
 assert.equal(f.writes.length,1);
 assert.equal(f.writes[0].table,'reports');
 assert.equal(f.writes[0].payload.conversation_id,'original-trade');
 f.context.safetyRequest++;
 f.nodes.safetyDetail.value='A new report draft';
 f.response.resolve({error:null});
 await first;
 assert.equal(f.nodes.safetyDetail.value,'A new report draft');
 assert.equal(f.notices.length,1);
 assert.equal(f.nodes.safetySubmit.disabled,false);
});
