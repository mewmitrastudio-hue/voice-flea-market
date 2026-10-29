import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const admin='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003';
const reportId='00000000-0000-4000-8000-000000000004';
const ids=[10,11,12].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
const sku='com.ayuhide.koenofurima.voice.jpy1000';
async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create schema voice_flea_private;grant usage on schema auth,voice_flea_private to authenticated,service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null$$;
 create function voice_flea_private.is_moderator() returns boolean language sql as $$select auth.uid()='${admin}'::uuid$$;
 create table public.payments(id uuid primary key,buyer_id uuid,seller_id uuid,amount_jpy int,payment_channel text,apple_environment text,apple_verified_at timestamptz,apple_transaction_id text,status text,refunded_amount_jpy int,platform_fee_jpy int,seller_amount_jpy int,paid_at timestamptz default now());
 create table public.conversations(payment_id uuid,is_inquiry boolean,delivery_status text);
 create table voice_flea_private.voice_iap_orders(payment_id uuid,state text,environment text,product_id text,transaction_id text,buyer_id uuid,seller_id uuid,amount_jpy int);
 create table voice_flea_private.apple_financial_reports(id uuid primary key,snapshot jsonb);
 set request.jwt.claim.sub='${admin}';`);
 const row={line:2,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',sku,quantity:3,unitProceeds:'636.36',proceeds:'1909.08',customerPrice:'1000.00'};
 await db.query('insert into voice_flea_private.apple_financial_reports values($1,$2)',[reportId,{rows:[row]}]);
 for(const [index,id] of ids.entries()){
  await db.query(`insert into payments(id,buyer_id,seller_id,amount_jpy,payment_channel,apple_environment,apple_verified_at,apple_transaction_id,status,refunded_amount_jpy,platform_fee_jpy,seller_amount_jpy) values($1,$2,$3,1000,'ios','Production',now(),$4,'paid',0,null,null)`,[id,other,seller,String(100+index)]);
  await db.query(`insert into conversations values($1,false,'accepted')`,[id]);
  await db.query(`insert into voice_flea_private.voice_iap_orders values($1,'paid','Production',$2,$3,$4,$5,1000)`,[id,sku,String(100+index),other,seller]);
 }
 await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261029033154_apple_proceeds_allocation_ledger.sql',import.meta.url),'utf8'));
 return db;
}
const allocate=(db,purchases=ids)=>db.query('select public.allocate_apple_proceeds($1,2,$2,$3) r',[reportId,purchases,'Operator explicitly matched all three report units to the selected payments.']);
test('completed Apple sales allocate exact report proceeds at 85/15, preserve fractional carry and retry without duplicate liabilities',async()=>{
 const db=await setup();try{
  await db.exec('set role authenticated');
  assert.equal((await db.query('select public.admin_apple_proceeds_workbook($1) r',[reportId])).rows[0].r.candidates.length,3);
  const first=(await allocate(db)).rows[0].r;
  assert.equal(first.allocated_jpy,1909);assert.equal(first.fractional_remainder,0.08);assert.equal(first.state,'allocated_unpaid');
  assert.equal((await allocate(db,[...ids].reverse())).rows[0].r.id,first.id);
  await db.exec('reset role');const rows=(await db.query('select * from voice_flea_private.apple_proceeds_allocations order by payment_id')).rows;
  assert.deepEqual(rows.map(r=>r.net_jpy),[637,636,636]);
  assert.deepEqual(rows.map(r=>r.platform_fee_jpy),[96,95,95]);
  assert.deepEqual(rows.map(r=>r.seller_amount_jpy),[541,541,541]);
  assert.equal(rows.reduce((sum,r)=>sum+r.platform_fee_jpy+r.seller_amount_jpy,0),1909);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_proceeds_notes')).rows[0].n,1);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(db.query('select public.admin_apple_proceeds_workbook($1)',[reportId]),/Operator required/);
  assert.equal((await db.query('select public.apple_proceeds_status() r')).rows[0].r.allocated_unpaid_jpy,1623);
  await db.exec(`set request.jwt.claim.sub='${other}'`);
  assert.equal((await db.query('select public.apple_proceeds_status() r')).rows[0].r.allocated_unpaid_jpy,0);
  await assert.rejects(db.query('select * from voice_flea_private.apple_proceeds_batches'),/permission denied/);
 }finally{await db.close();}
});
test('Sandbox, mismatched, refunded, unfinished and repeated selections cannot allocate production seller proceeds',async()=>{
 const db=await setup();try{
  await assert.rejects(allocate(db,[ids[0],ids[0],ids[1]]),/Duplicate payment/);
  await assert.rejects(allocate(db,[ids[0]]),/units or proceeds mismatch/);
  for(const [column,value,original] of [['apple_environment','Sandbox','Production'],['status','refunded','paid'],['apple_transaction_id','wrong','100']]){
   await db.query(`update payments set ${column}=$1 where id=$2`,[value,ids[0]]);
   await assert.rejects(allocate(db),/Completed verified unallocated/);
   await db.query(`update payments set ${column}=$1 where id=$2`,[original,ids[0]]);
  }
  await db.query("update conversations set delivery_status='submitted' where payment_id=$1",[ids[0]]);
  await assert.rejects(allocate(db),/Completed verified unallocated/);
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_proceeds_batches')).rows[0].n,0);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(allocate(db),/Operator required/);
  await db.exec('reset role;set role anon');await assert.rejects(allocate(db),/permission denied/);
 }finally{await db.close();}
});
test('a later refund freezes the existing allocation, retains its audit and never turns a retry into an unpaid balance',async()=>{
 const db=await setup();try{
  await allocate(db);await db.query("update payments set status='refunded',refunded_amount_jpy=1000 where id=$1",[ids[0]]);
  await db.exec(`set request.jwt.claim.sub='${seller}'`);
  const status=(await db.query('select public.apple_proceeds_status() r')).rows[0].r;
  assert.equal(status.allocated_unpaid_jpy,1082);assert.equal(status.adjustment_count,1);
  await db.exec(`set request.jwt.claim.sub='${admin}'`);
  assert.equal((await allocate(db)).rows[0].r.state,'adjustment_required');
  assert.equal((await db.query('select count(*)::int n from voice_flea_private.apple_proceeds_batches')).rows[0].n,1);
 }finally{await db.close();}
});
test('operator UI records the selected report and payments once, and discards private results after account switch',async()=>{
 const elements=new Map(),node=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',checked:false,disabled:false,replaceChildren(){this.innerHTML='';this.textContent='';}});return elements.get(id);};
 let finish;const calls=[];
 const c={currentUser:{id:admin},Number,Array,Error,document:{getElementById:node,querySelectorAll:()=>ids.map(value=>({value}))},isVoiceFleaAdmin:()=>c.currentUser?.id===admin,esc:v=>String(v).replaceAll('<','&lt;').replaceAll('"','&quot;'),formatJpDateTime:String,financeYen:v=>v+'円',sb:{rpc:async(name,args)=>{
  calls.push({name,args});if(name==='allocate_apple_proceeds')return new Promise(r=>finish=r);
  return {data:{id:reportId,rows:[{line:2,sku,kind:'S',country:'JP',currency:'JPY',customerCurrency:'JPY',quantity:3,proceeds:'1909.08',customerPrice:'1000'}],batches:[],candidates:ids.map(id=>({id,product_id:sku,amount_jpy:1000,seller_id:seller,apple_transaction_id:'123'}))}};
 }}};
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');vm.createContext(c);
 vm.runInContext(html.slice(html.indexOf('let appleFinanceRevision='),html.indexOf('const adminPaymentViews=')),c);
 await c.openAppleProceedsWorkbook(reportId);assert.match(node('appleProceedsWorkbook').innerHTML,/財務レポートには取引IDがありません/);
 node('appleProceedsLine').value='2';node('appleProceedsNote').value='Matched the actual report units to these payment records.';node('appleProceedsAttest').checked=true;
 const saving=c.saveAppleProceedsAllocation();await c.saveAppleProceedsAllocation();
 assert.equal(calls.filter(x=>x.name==='allocate_apple_proceeds').length,1);
 assert.equal(calls.at(-1).args.report,reportId);assert.deepEqual([...calls.at(-1).args.purchases],ids);
 finish({data:{id:'batch',allocated_jpy:1909,fractional_remainder:0.08,state:'allocated_unpaid'}});await saving;
 assert.match(node('appleProceedsMessage').textContent,/送金はまだ行っていません/);
 await c.openAppleProceedsWorkbook(reportId);node('appleProceedsAttest').checked=true;
 const switched=c.saveAppleProceedsAllocation();c.currentUser={id:other};c.resetAppleFinancialReport();
 finish({data:{id:'private-batch',allocated_jpy:1909,state:'allocated_unpaid'}});await switched;
 assert.equal(node('appleProceedsWorkbook').innerHTML,'');
});
