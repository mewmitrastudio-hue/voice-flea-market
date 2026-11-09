import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const seller='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',listing='00000000-0000-4000-8000-000000000003';
const read=name=>fs.readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
async function fixture(){
 const db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;create schema voice_flea_private;
 create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null$$;
 create table listings(id uuid primary key,seller_id uuid,is_active boolean);
 insert into listings values('${listing}','${seller}',true);
 create table voice_flea_private.boost_orders(id uuid primary key default gen_random_uuid(),seller_id uuid,listing_id uuid,plan text,product_id text,state text default 'pending',environment text,transaction_id text unique,created_at timestamptz default now(),applied_at timestamptz);
 create table listing_boosts(id uuid primary key default gen_random_uuid(),listing_id uuid,seller_id uuid,plan text,amount_jpy integer,duration_days integer,status text,starts_at timestamptz,ends_at timestamptz,apple_transaction_id text unique,payment_source text,environment text);
 `);
 // Existing wrapper can be created before its runtime callee.
 await db.exec(read('20261028020000_priced_boost_receipts.sql'));
 await db.exec(read('20261109010000_dual_iap_preparation.sql'));
 return db;
}
const prepare=(db,env='Sandbox')=>db.query('select public.prepare_boost_order_in_environment($1,$2,$3,$4) r',[seller,listing,'silver',env]).then(x=>x.rows[0].r);
const apply=(db,order,env='Sandbox',tx='123',actor=seller,revoked=false)=>db.query('select public.apply_owned_priced_apple_boost($1,$2,$3,$4,now(),$5,300000,\'JPY\',$6) r',[order,tx,'com.ayuhide.koenofurima.boost.silver',env,revoked,actor]).then(x=>x.rows[0].r);
test('new boost orders bind environment and owner; signed Sandbox cannot become Production or another account entitlement',async()=>{
 const db=await fixture();try{
  const order=await prepare(db);assert.equal(order.environment,'Sandbox');assert.equal((await prepare(db)).orderId,order.orderId);
  for(const [env,actor] of [['Production',seller],['Sandbox',other],['Sandbox',null]])await assert.rejects(apply(db,order.orderId,env,'123',actor),/mismatch/);
  assert.equal((await db.query('select count(*)::int n from listing_boosts')).rows[0].n,0);
  const first=await apply(db,order.orderId);assert.equal(first.environment,'Sandbox');assert.equal((await apply(db,order.orderId)).boostId,first.boostId);
  await assert.rejects(apply(db,order.orderId,'Production'),/mismatch/);
  await assert.rejects(apply(db,order.orderId,'Sandbox','999'),/consumed/);
  const production=await prepare(db,'Production');assert.notEqual(production.orderId,order.orderId,'Sandbox history does not block a paid boost');
  await assert.rejects(apply(db,production.orderId,'Production','123'),/unique constraint/,'legacy globally unique transaction IDs fail closed on cross-env collision');
  await apply(db,production.orderId,'Production','456');
  await apply(db,order.orderId,'Sandbox','123',seller,true);
  const rows=(await db.query('select environment,status from listing_boosts order by environment')).rows;
  assert.deepEqual(rows,[{environment:'Production',status:'active'},{environment:'Sandbox',status:'cancelled'}]);
  await db.exec('set role authenticated');await assert.rejects(prepare(db),/permission denied/);await assert.rejects(apply(db,production.orderId,'Production','456'),/permission denied/);
 }finally{await db.close();}
});
test('legacy NULL-environment interrupted order survives upgrade; first verified receipt binds it once',async()=>{
 const db=await fixture();try{
  const old=(await db.query("insert into voice_flea_private.boost_orders(seller_id,listing_id,plan,product_id) values($1,$2,'silver','com.ayuhide.koenofurima.boost.silver') returning id",[seller,listing])).rows[0].id;
  const fresh=await prepare(db);assert.notEqual(fresh.orderId,old,'never repurpose an unknown pending transaction');
  await apply(db,old);await assert.rejects(apply(db,old,'Production'),/mismatch/);
  assert.equal((await apply(db,old)).alreadyApplied,true);
 }finally{await db.close();}
});
