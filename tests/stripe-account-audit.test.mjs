import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {stripeAccountAudit} from '../supabase/functions/_shared/stripe-account-audit.mjs';

function stripeFixture({balanceError=false,payoutError=false,balanceLive=true,payoutLive=true}={}){
 const calls=[];
 const stripe={accounts:{retrieve:async()=>{calls.push('account');return {object:'account',id:'acct_ServerConfigured',email:'private@example.invalid',external_accounts:{data:[{account_number:'not-for-output'}]},charges_enabled:true};}},
  balance:{retrieve:async()=>{calls.push('balance');if(balanceError)throw Error('sensitive upstream error');return {object:'balance',livemode:balanceLive,available:[{currency:'jpy',amount:0}],pending:[{currency:'jpy',amount:-100}]};}},
  payouts:{list:async options=>{calls.push(['payouts',options]);if(payoutError)throw Error('sensitive upstream error');return {object:'list',has_more:true,data:[{object:'payout',id:'po_One',amount:500,currency:'jpy',livemode:payoutLive,status:'paid',arrival_date:1793145600,created:1793059200,destination:'ba_private'}]};}}};
 return {stripe,calls};
}
test('server account audit returns only sanitized evidence and a bounded payout page, never bank details or capability claims',async()=>{
 const f=stripeFixture(),r=await stripeAccountAudit(f.stripe,true);
 assert.equal(r.accountId,'acct_ServerConfigured');assert.equal(r.livemode,true);
 assert.equal(r.balance.available[0].amount,0);assert.equal(r.balance.pending[0].amount,-100);
 assert.equal(r.balance.connectReserved,null);assert.equal(r.payouts.hasMore,true);assert.equal(r.payouts.rows[0].status,'paid');
 assert.deepEqual(f.calls,['account','balance',['payouts',{limit:10}]]);
 assert.doesNotMatch(JSON.stringify(r),/private|charges_enabled|external_accounts|bankReceipt|profit/);
});
test('permission failures, malformed money and mode mismatches stay unknown instead of becoming zero',async()=>{
 const denied=stripeFixture({balanceError:true});let r=await stripeAccountAudit(denied.stripe,true);
 assert.deepEqual(r.balance,{state:'unavailable'});assert.equal(r.payouts.state,'verified');assert.doesNotMatch(JSON.stringify(r),/sensitive/);
 const wrong=stripeFixture({balanceLive:false,payoutLive:false});r=await stripeAccountAudit(wrong.stripe,true);
 assert.equal(r.balance.state,'unavailable');assert.equal(r.payouts.state,'unavailable');
 const bad=stripeFixture();bad.stripe.balance.retrieve=async()=>({object:'balance',livemode:true,available:[{currency:'jpy',amount:'1000'}],pending:[]});
 r=await stripeAccountAudit(bad.stripe,true);assert.equal(r.balance.state,'unavailable');
 const missing=stripeFixture();missing.stripe.accounts.retrieve=async()=>({object:'account',id:null});
 await assert.rejects(stripeAccountAudit(missing.stripe,true));assert.deepEqual(missing.calls,[]);
});
function edgeFixture({adminId='operator'}={}){
 let handler,clients=0,reads=0;
 const c={Response,Request,JSON,Deno:{env:{get:n=>({ADMIN_USER_ID:adminId,SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'unit-only',STRIPE_SECRET_KEY:'rk_live_UNITONLY'})[n]},serve:fn=>handler=fn},
  createClient:()=>({auth:{getUser:async token=>({data:{user:token==='invalid'?null:{id:token}},error:token==='invalid'?{}:null})}}),
  Stripe:class{constructor(key,options){assert.equal(key,'rk_live_UNITONLY');assert.equal(options.maxNetworkRetries,1);clients++;}},
  stripeAccountAudit:async(_,live)=>{reads++;assert.equal(live,true);return {accountId:'acct_ServerConfigured',livemode:true};}};
 vm.createContext(c);
 const source=fs.readFileSync(new URL('../supabase/functions/stripe-account-audit/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source),c);
 const send=(token,body={})=>handler(new Request('https://edge.invalid',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:JSON.stringify(body)}));
 return {send,counts:()=>({clients,reads})};
}
test('audit Edge rejects unauthenticated and non-operator callers before constructing a Stripe client',async()=>{
 const f=edgeFixture();assert.equal((await f.send(null)).status,401);assert.equal((await f.send('invalid')).status,401);assert.equal((await f.send('someone')).status,403);
 assert.deepEqual(f.counts(),{clients:0,reads:0});
 const r=await f.send('operator',{accountId:'acct_Attacker',key:'attacker',live:false,action:'transfer'});
 assert.equal(r.status,200);assert.equal((await r.json()).accountId,'acct_ServerConfigured');assert.deepEqual(f.counts(),{clients:1,reads:1});
 const unconfigured=edgeFixture({adminId:''});assert.equal((await unconfigured.send('operator')).status,503);assert.deepEqual(unconfigured.counts(),{clients:0,reads:0});
});

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function uiFixture(){
 let resolve;const request=new Promise(r=>resolve=r),nodes=new Map(['adminStripeAuditResult','adminStripeAuditButton'].map(id=>[id,{textContent:'',innerHTML:'',disabled:false}]));
 const c={currentUser:{id:'operator'},sb:{functions:{invoke:async()=>request}},document:{getElementById:id=>nodes.get(id)},isVoiceFleaAdmin:()=>c.currentUser?.id==='operator',esc:String,financeYen:n=>`${n}円`,formatJpDateTime:String,Number,Date};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('let adminStripeAuditRevision='),html.indexOf('function closeAdminDashboard()')),c);
 return {c,nodes,resolve};
}
const audit={success:true,accountId:'acct_ServerConfigured',livemode:false,observedAt:'2026-10-28T00:00:00Z',balance:{state:'unavailable'},payouts:{state:'verified',rows:[],hasMore:false}};
test('operator UI labels test money and unavailable balance, and discards results after account switch',async()=>{
 const f=uiFixture(),p=f.c.loadAdminStripeAccountAudit();f.resolve({data:audit});await p;
 const body=f.nodes.get('adminStripeAuditResult');assert.match(body.innerHTML,/Stripe・テスト/);assert.match(body.innerHTML,/金額は未確認/);assert.match(body.innerHTML,/最大10件/);assert.doesNotMatch(body.innerHTML,/利用可能：0円/);
 const switched=uiFixture(),q=switched.c.loadAdminStripeAccountAudit();switched.c.currentUser={id:'other'};switched.resolve({data:audit});await q;assert.equal(switched.nodes.get('adminStripeAuditResult').innerHTML,'');
 const failed=uiFixture(),t=failed.c.loadAdminStripeAccountAudit();failed.resolve({error:{message:'secret upstream error'}});await t;assert.doesNotMatch(failed.nodes.get('adminStripeAuditResult').textContent,/secret/);assert.match(failed.nodes.get('adminStripeAuditResult').textContent,/照合できません/);
});
