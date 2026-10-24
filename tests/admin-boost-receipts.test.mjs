import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
test('operator receipts enforce authorization and keep live/test totals separate across full pagination',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema voice_flea_private;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function voice_flea_private.is_moderator() returns boolean language sql stable as $$select auth.uid()='00000000-0000-4000-8000-000000000001'::uuid$$;
   grant usage on schema auth,voice_flea_private to authenticated;
   create table public.listings(id uuid primary key,title text);
   create table public.listing_boosts(id uuid primary key,listing_id uuid,seller_id uuid,plan text,amount_jpy int,duration_days int,status text,environment text,created_at timestamptz,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text,payment_source text);
   alter table public.listing_boosts enable row level security;
   create policy own on public.listing_boosts for select to authenticated using(seller_id=auth.uid());
   grant select on public.listing_boosts to authenticated;
   insert into public.listing_boosts select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,null,
    '00000000-0000-4000-8000-000000000002','silver',300,3,
    case when n=1 then 'cancelled' else 'active' end,case when n<=20 then 'Production' else 'Sandbox' end,
    '2026-10-01 00:00Z',now()-interval '2 days',case when n=2 then now()-interval '1 day' else now()+interval '1 day' end,n::text,'apple'
   from generate_series(1,25)n;
   insert into public.listing_boosts values('00000000-0000-4000-8000-000000000099',null,null,'gold',800,12,'pending','Production',now(),now(),now(),null,'apple');
  `);
  const dir=new URL('../supabase/migrations/',import.meta.url);
  const file=fs.readdirSync(dir).find(x=>x.endsWith('_admin_boost_receipts.sql'));
  await db.exec(fs.readFileSync(new URL(file,dir),'utf8'));
  const {rows:priv}=await db.query(`select has_function_privilege('anon','public.admin_boost_receipts(timestamptz,uuid)','execute') anon,has_function_privilege('authenticated','public.admin_boost_receipts(timestamptz,uuid)','execute') signed_in,(select prosecdef from pg_proc where oid='public.admin_boost_receipts(timestamptz,uuid)'::regprocedure) public_definer`);
  assert.deepEqual(priv[0],{anon:false,signed_in:true,public_definer:false});
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select public.admin_boost_receipts()'),/Operator access required/);
  await db.exec(`set request.jwt.claim.sub='00000000-0000-4000-8000-000000000002'`);
  await assert.rejects(db.query('select public.admin_boost_receipts()'),/Operator access required/);
  await db.exec(`set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001'`);
  const own=await db.query('select count(*)::int n from public.listing_boosts');assert.equal(own.rows[0].n,0,'table RLS remains intact');
  const query=async(cursor)=> (await db.query('select public.admin_boost_receipts($1,$2) result',[cursor?.created_at||null,cursor?.id||null])).rows[0].result;
  const first=await query();
  assert.equal(first.summary.find(x=>x.environment==='Production').confirmed_count,20);
  assert.equal(first.summary.find(x=>x.environment==='Production').valid_reference_amount_jpy,5700);
  assert.equal(first.summary.find(x=>x.environment==='Production').effective_count,18);
  assert.equal(first.summary.find(x=>x.environment==='Sandbox').confirmed_count,5);
  assert.equal(first.summary.find(x=>x.environment==='Sandbox').valid_reference_amount_jpy,1500);
  const all=[...first.rows];let page=first;
  while(page.has_more){page=await query(page.rows.at(-1));all.push(...page.rows);assert.deepEqual(page.summary,first.summary);}
  assert.equal(all.length,25);assert.equal(new Set(all.map(x=>x.id)).size,25,'same-time rows have no gaps or duplicates');
  assert.equal((await query(all.at(-1))).rows.length,0);
  await assert.rejects(db.query("select public.admin_boost_receipts(now(),null)"),/Incomplete cursor/);
 }finally{await db.close();}
});

function fixture(rpc){
 const nodes=new Map(['adminBoostSummary','adminBoostReceipts','adminBoostMore'].map(id=>[id,{innerHTML:'',textContent:'',disabled:false,classList:{toggle(){},add(){}},appendChild(n){this.innerHTML+=n.textContent;}}]));
 const context={sb:{rpc},currentUser:{id:'operator'},document:{getElementById:id=>nodes.get(id),createElement:()=>({})},isVoiceFleaAdmin:()=>context.currentUser?.id==='operator',Date,Map,Number,String,Error,esc:s=>String(s).replaceAll('<','&lt;'),financeYen:n=>`${n}円`,formatJpDateTime:x=>x};
 vm.createContext(context);
 vm.runInContext(html.slice(html.indexOf('let adminBoostRows='),html.indexOf('function closeAdminRefundCenter()'))+'\nthis.boostRows=()=>adminBoostRows;',context);
 return {context,nodes};
}
const receipt={id:'1',listing_title:'<test>',plan:'silver',reference_amount_jpy:300,environment:'Sandbox',status:'active',created_at:'2026-10-01',starts_at:'2026-01-01',ends_at:'2099-01-01',apple_transaction_id:'123',seller_id:'seller'};
test('failed next page preserves receipts and retries the same cursor',async()=>{
 let calls=0;const cursors=[];
 const {context:c,nodes}=fixture(async(name,args)=>{cursors.push(args);calls++;if(calls===2)return{error:new Error('offline')};return{data:{rows:calls===1?[receipt]:[{...receipt,id:'2'}],summary:[],has_more:calls===1}};});
 await c.loadAdminBoostReceipts();assert.equal(c.boostRows().length,1);assert.match(nodes.get('adminBoostReceipts').innerHTML,/&lt;test>/);
 await c.loadAdminBoostReceipts(true);assert.equal(c.boostRows().length,1);assert.equal(nodes.get('adminBoostMore').disabled,false);
 await c.loadAdminBoostReceipts(true);assert.equal(c.boostRows().length,2);assert.deepEqual(cursors[1],cursors[2]);
 assert.match(nodes.get('adminBoostReceipts').innerHTML,/テスト購入/);
});
test('stale refresh and account-switch responses cannot render operator receipts',async()=>{
 const pending=[];const {context:c,nodes}=fixture(()=>new Promise(resolve=>pending.push(resolve)));
 const old=c.loadAdminBoostReceipts(),fresh=c.loadAdminBoostReceipts();
 pending[1]({data:{rows:[],summary:[],has_more:false}});await fresh;
 pending[0]({data:{rows:[receipt],summary:[],has_more:false}});await old;assert.equal(c.boostRows().length,0);
 const switched=c.loadAdminBoostReceipts();c.currentUser={id:'ordinary'};pending[2]({data:{rows:[receipt],summary:[],has_more:false}});await switched;
 assert.equal(c.boostRows().length,0);assert.doesNotMatch(nodes.get('adminBoostReceipts').innerHTML,/seller/);
});
