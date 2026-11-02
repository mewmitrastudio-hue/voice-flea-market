import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {parseAppleFinancialReport,appleFinancialReportSnapshot} from '../supabase/functions/_shared/apple-financial-report.mjs';
const operator='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const sku='com.ayuhide.koenofurima.voice.jpy1000';
const headers=['Start Date','End Date','Vendor Identifier','Quantity','Partner Share','Extended Partner Share','Partner Share Currency','Sale or Return','Country of Sale','Customer Price','Customer Currency'];
const line=(overrides={})=>Object.values({'Start Date':'09/27/2026','End Date':'10/31/2026','Vendor Identifier':sku,Quantity:'3','Partner Share':'636.36','Extended Partner Share':'1909.08','Partner Share Currency':'JPY','Sale or Return':'S','Country of Sale':'JP','Customer Price':'1000.00','Customer Currency':'JPY',...overrides}).join('\t');
const report=(rows=[line()])=>headers.join('\t')+'\n'+rows.join('\n')+'\n';
test('financial report preserves exact proceeds and currency totals, including returns and unrelated products',()=>{
 const r=parseAppleFinancialReport('\uFEFF'+report([line(),line({Quantity:'-1','Extended Partner Share':'-636.36','Sale or Return':'R','Customer Price':'-1000.00'}),line({'Partner Share Currency':'USD','Partner Share':'0.10','Extended Partner Share':'0.30','Country of Sale':'US','Customer Currency':'USD','Customer Price':'1.00'}),line({'Vendor Identifier':'unrelated.app'})]).replaceAll('\n','\r\n'));
 assert.equal(r.periodStart,'2026-09-27');assert.equal(r.periodEnd,'2026-10-31');
 assert.deepEqual(r.totals,[{supported:true,currency:'JPY',saleUnits:3,returnUnits:1,proceeds:'1272.72'},{supported:true,currency:'USD',saleUnits:3,returnUnits:0,proceeds:'0.30'},{supported:false,currency:'JPY',saleUnits:3,returnUnits:0,proceeds:'1909.08'}]);
 assert.equal(r.state,'document_imported_unreconciled');assert.equal(r.rows.some(x=>'transactionId' in x),false);
});
test('bad totals, currency, dates, quantities, precision, duplicate headers and mixed periods are rejected',()=>{
 for(const row of [line({'Extended Partner Share':'1909.09'}),line({'Partner Share Currency':'YEN!'}),line({'Start Date':'02/30/2026'}),line({Quantity:'0'}),line({Quantity:'3.0'}),line({'Partner Share':'0.1234567'}),line({'Sale or Return':'R'}),line({'Customer Price':'1e3'})])assert.throws(()=>parseAppleFinancialReport(report([row])));
 assert.throws(()=>parseAppleFinancialReport(report([line(),line({'Start Date':'10/01/2026'})])));
 assert.throws(()=>parseAppleFinancialReport(report().replace('Quantity','Start Date')));
 assert.throws(()=>parseAppleFinancialReport('Developer Proceeds\tUnits\n850\t1'));
 assert.throws(()=>parseAppleFinancialReport('x'.repeat(1048577)));
});
test('detailed report SKU format and micro precision are accepted without rounding away money',()=>{
 const r=parseAppleFinancialReport(report([line({'Partner Share':'0.000001','Extended Partner Share':'0.000003'})]).replace('Vendor Identifier','SKU'));
 assert.equal(r.totals[0].proceeds,'0.000003');
});
test('server fingerprint identifies the actual bytes independently of the file name',async()=>{
 const a=await appleFinancialReportSnapshot(report(),'first.txt'),b=await appleFinancialReportSnapshot(report(),'renamed.txt');assert.equal(a.sha256,b.sha256);assert.match(a.sha256,/^[a-f0-9]{64}$/);
 assert.notEqual(a.sha256,(await appleFinancialReportSnapshot(report().replace('636.36','636.35').replace('1909.08','1909.05'))).sha256);
});
function edge(){
 let handler;const calls=[];
 const context={Response,Request,Uint8Array,TextDecoder,JSON,appleFinancialReportSnapshot,
 Deno:{env:{get:k=>({SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only',ADMIN_USER_ID:operator})[k]},serve:f=>handler=f},
 createClient:()=>({auth:{getUser:async token=>({data:{user:token==='operator'?{id:operator}:token==='other'?{id:other}:null}})},rpc:async(name,args)=>{calls.push({name,args});return {data:{id:'report',state:'document_imported_unreconciled'}};}})};
 vm.createContext(context);vm.runInContext(stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/apple-financial-reports/index.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'')),context);
 return {calls,send:(body,token='operator')=>handler(new Request('https://edge.invalid',{method:'POST',headers:token?{Authorization:`Bearer ${token}`}:{},body:typeof body==='string'?body:JSON.stringify(body)}))};
}
test('Edge preview is read-only and import is bound to the server fingerprint and authenticated operator',async()=>{
 const e=edge();assert.equal((await e.send({},null)).status,401);assert.equal((await e.send({},'bad')).status,401);assert.equal((await e.send({},'other')).status,403);
 const preview=await (await e.send({action:'preview',text:report(),name:'finance.txt'})).json();assert.equal(e.calls.length,0);
 assert.equal((await e.send({action:'import',text:report(),sha256:'forged'})).status,409);
 assert.equal((await e.send({action:'import',text:report(),sha256:preview.snapshot.sha256,actor:other,snapshot:{proceeds:999999}})).status,200);
 assert.equal(e.calls[0].name,'store_apple_financial_report');assert.equal(e.calls[0].args.actor,operator);assert.equal(e.calls[0].args.snapshot.totals[0].proceeds,'1909.08');
 assert.equal((await e.send({action:'import',text:'not a financial report',sha256:preview.snapshot.sha256})).status,422);assert.equal(e.calls.length,1);
});
test('Edge rejects oversized streaming bodies before parsing and never echoes report data',async()=>{
 const e=edge(),r=await e.send('x'.repeat(2200001));assert.equal(r.status,413);assert.equal(e.calls.length,0);assert.ok((await r.text()).length<200);
});
test('SQL import is operator-only, idempotent, keeps report evidence, and cannot update payments',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema voice_flea_private;
  grant usage on schema public,auth,voice_flea_private to anon,authenticated,service_role;
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  create table voice_flea_private.moderators(user_id uuid);insert into voice_flea_private.moderators values('${operator}');
  create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null$$;
  create function voice_flea_private.is_moderator() returns boolean language sql security definer set search_path='' as $$select exists(select 1 from voice_flea_private.moderators where user_id=auth.uid())$$;
  create table payments(id integer primary key,seller_amount_jpy integer);insert into payments values(1,null);`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261029014305_apple_financial_report_import.sql',import.meta.url),'utf8'));
  const snapshot=await appleFinancialReportSnapshot(report(),'finance.txt');
  await db.exec('set role anon');await assert.rejects(db.query('select public.admin_apple_financial_reports()'));
  await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${other}'`);await assert.rejects(db.query('select public.admin_apple_financial_reports()'));
  await db.exec(`set request.jwt.claim.sub='${operator}'`);await assert.rejects(db.query('select public.store_apple_financial_report($1,$2,$3)',[operator,snapshot,report()]));
  await assert.rejects(db.query('select * from voice_flea_private.apple_financial_reports'));
  await db.exec('reset role;set role service_role');await assert.rejects(db.query('select public.store_apple_financial_report($1,$2,$3)',[other,snapshot,report()]));
  await assert.rejects(db.query('select public.store_apple_financial_report($1,$2,$3)',[operator,snapshot,'changed source']));
  const first=(await db.query('select public.store_apple_financial_report($1,$2,$3) r',[operator,snapshot,report()])).rows[0].r;
  const second=(await db.query('select public.store_apple_financial_report($1,$2,$3) r',[operator,{...snapshot,sourceName:'renamed.txt'},report()])).rows[0].r;assert.equal(first.id,second.id);
  await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${operator}'`);
  const history=(await db.query('select public.admin_apple_financial_reports() r')).rows[0].r;assert.equal(history.length,1);assert.equal(history[0].totals[0].proceeds,'1909.08');assert.equal(history[0].state,'document_imported_unreconciled');assert.equal('source_text' in history[0],false);
  await db.exec('reset role');assert.equal((await db.query('select seller_amount_jpy from payments')).rows[0].seller_amount_jpy,null);assert.equal((await db.query('select source_text from voice_flea_private.apple_financial_reports')).rows[0].source_text,report());
 }finally{await db.close();}
});
test('report UI escapes file names, refuses stale previews, and discards reads after an account switch',async()=>{
 const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,{textContent:'',innerHTML:'',disabled:false,value:'',replaceChildren(){this.textContent='';this.innerHTML='';}});return elements.get(id);};
 let resolvePreview,resolveHistory;
 const c={currentUser:{id:operator},TextDecoder,Number,Array,Error,document:{getElementById:el},isVoiceFleaAdmin:()=>c.currentUser?.id===operator,esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),sb:{functions:{invoke:()=>new Promise(r=>resolvePreview=r)},rpc:()=>new Promise(r=>resolveHistory=r)}};
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8'),src=html.slice(html.indexOf('let appleFinanceRevision='),html.indexOf('const adminPaymentViews='));vm.createContext(c);vm.runInContext(src,c);
 const file={size:10,name:'finance.txt',arrayBuffer:async()=>new TextEncoder().encode(report()).buffer};
 const first=c.previewAppleFinancialReport(file);await new Promise(r=>setImmediate(r));
 await c.previewAppleFinancialReport(null);resolvePreview({data:{success:true,snapshot:{sha256:'old'}}});await first;assert.equal(el('appleFinanceImport').disabled,true);assert.equal(el('appleFinancePreview').textContent,'');
 const history=c.loadAppleFinancialReports();c.currentUser={id:other};resolveHistory({data:[{source_name:'private report',totals:[]}]});await history;assert.equal(el('appleFinanceHistory').innerHTML,'');
 c.currentUser={id:operator};const fresh=c.loadAppleFinancialReports();resolveHistory({data:[{source_name:'<img src=x onerror=alert(1)>',period_start:'2026-09-27',period_end:'2026-10-31',totals:[]}]});await fresh;assert.match(el('appleFinanceHistory').innerHTML,/&lt;img/);assert.doesNotMatch(el('appleFinanceHistory').innerHTML,/<img/);
 c.resetAppleFinancialReport();assert.equal(el('appleFinanceHistory').innerHTML,'');assert.equal(el('appleFinanceFile').value,'');
});
