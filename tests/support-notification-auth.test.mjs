import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../supabase/functions/send-support-notification/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function setup({invalid=false,sent=false,deliveryOk=true}={}){
 let handler;const calls=[],emails=[];
 const ctx={Request,Response,console:{error(){}},Deno:{serve:fn=>handler=fn,env:{get:k=>({SUPABASE_URL:'https://unit.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit-only',RESEND_API_KEY:'unit-mail',SUPPORT_NOTIFY_TO:'operator@example.invalid'})[k]}},
 createClient:()=>({rpc:async(name,args)=>{calls.push([name,args]);return name==='notification_payload'?{error:invalid?{code:'42501'}:null,data:{already_sent:sent,key:'trusted-event',record:{reply_email:'trusted@example.invalid',message:'trusted body'}}}:{error:null};}}),
 fetch:async(url,opts)=>{emails.push({url,...opts});return {ok:deliveryOk};}};
 vm.runInNewContext(source,ctx);
 const send=(token,body={kind:'support',record:{id:'item-1'}},method='POST')=>handler(new Request('https://unit.invalid',{method,headers:token?{'x-notification-token':token}:{},...(method==='POST'?{body:JSON.stringify(body)}:{})}));
 return {send,calls,emails};
}
test('notification endpoint rejects missing authentication and wrong methods before database or mail access',async()=>{
 const f=setup();assert.equal((await f.send(null)).status,401);assert.equal((await f.send('unit',undefined,'GET')).status,405);assert.equal(f.calls.length,0);assert.equal(f.emails.length,0);
});
test('database token rejection never sends email',async()=>{
 const f=setup({invalid:true});assert.equal((await f.send('forged')).status,403);assert.equal(f.emails.length,0);assert.equal(f.calls.length,1);
});
test('notification payload must have an allowlisted kind and persisted record identity',async()=>{
 const f=setup();for(const body of [{kind:'admin',record:{id:'x'}},{kind:'support',message:'forged'}])assert.equal((await f.send('unit',body)).status,400);assert.equal(f.calls.length,0);
});
test('email uses verified database payload and idempotency key, never caller supplied content',async()=>{
 const f=setup();assert.equal((await f.send('unit',{kind:'support',record:{id:'item-1',reply_email:'attacker',message:'forged'}})).status,200);
 assert.match(f.emails[0].body,/trusted body/);assert.doesNotMatch(f.emails[0].body,/forged|attacker/);assert.equal(f.emails[0].headers['Idempotency-Key'],'trusted-event');assert.equal(f.calls[1][0],'record_notification_sent');
});
test('already sent notification is not repeated and provider failure is not marked sent',async()=>{
 const sent=setup({sent:true});assert.equal((await sent.send('unit')).status,200);assert.equal(sent.emails.length,0);
 const failed=setup({deliveryOk:false});const response=await failed.send('unit');assert.equal(response.status,500);assert.equal(failed.calls.length,1);assert.doesNotMatch(await response.text(),/unit-mail|trusted body/);
});
