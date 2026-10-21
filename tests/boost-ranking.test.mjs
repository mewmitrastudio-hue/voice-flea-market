import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('SQL ranks tiers, rotates fairly, pins pagination and excludes invalid boosts', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create table public.profiles(id uuid primary key,display_name text,avatar_path text);
      create table public.listings(id uuid primary key,title text,category text,description text,price_jpy integer,delivery_days integer,ai_use text,sample_path text,seller_id uuid,created_at timestamptz,is_active boolean);
      create table public.listing_boosts(listing_id uuid,plan text,starts_at timestamptz,ends_at timestamptz,status text,environment text);
      create function public.is_voice_purchased(listing uuid) returns boolean language sql as $$ select false $$;
      create function public.public_active_boosts(listing_ids uuid[])
      returns table(listing_id uuid,plan text,starts_at timestamptz,ends_at timestamptz)
      language sql stable security definer set search_path='' as $$
        select b.listing_id,b.plan,b.starts_at,b.ends_at from public.listing_boosts b join public.listings l on l.id=b.listing_id
        where b.listing_id=any(listing_ids) and cardinality(listing_ids)<=100 and b.status='active' and b.environment='Production' and b.starts_at<=now() and b.ends_at>now() and l.is_active
      $$;
      insert into public.profiles values ('00000000-0000-4000-8000-000000000001','seller',null);
      insert into public.listings
      select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
      'voice '||n,'voice','narration',100+n,n%14+1,'no',null,
      '00000000-0000-4000-8000-000000000001',now()-make_interval(days=>n/80),true from generate_series(1,320) n;
      insert into public.listing_boosts
      select id,case when right(id::text,12)::int<=80 then 'platinum' when right(id::text,12)::int<=160 then 'gold' else 'silver' end,
      now()-interval '1 day',now()+interval '1 day','active','Production'
      from public.listings where right(id::text,12)::int<=240;
    `);
    const migrations = new URL('../supabase/migrations/', import.meta.url);
    const file = fs.readdirSync(migrations).find(f => f.endsWith('_boost_tier_priority.sql'));
    await db.exec(fs.readFileSync(new URL(file, migrations),'utf8'));
    const search = async (seed, offset=0, size=100, sort='recommended', maxPrice=null, query='') => {
      const {rows}=await db.query(`select public.search_voice_listings_ranked(search_text=>$1,page_offset=>$2,page_size=>$3,sort_by=>$4,max_price=>$5,rotation_epoch=>$6) result`,[query,offset,size,sort,maxPrice,seed]);
      return rows[0].result;
    };
    const all=[];
    for(let offset=0;offset<320;offset+=24) all.push(...(await search(10,offset,24)).rows);
    assert.equal(all.length,320);
    assert.equal(new Set(all.map(r=>r.id)).size,320,'no duplicates across pinned pages');
    assert.ok(all.slice(0,80).every(r=>r.boost_plan==='platinum'));
    assert.ok(all.slice(80,160).every(r=>r.boost_plan==='gold'));
    assert.ok(all.slice(160,240).every(r=>r.boost_plan==='silver'));
    assert.ok(all.slice(240).every(r=>r.boost_plan===null));
    assert.ok(!('rotation_index' in all[0]),'internal sort columns stay private');
    const leaders=new Set();
    for(let seed=0;seed<80;seed++)leaders.add((await search(seed,0,1)).rows[0].id);
    assert.equal(leaders.size,80,'every platinum listing gets a turn');
    assert.deepEqual((await search(10)).rows,(await search(10)).rows,'same epoch is stable');
    for(const [sort,key] of [['price','price_jpy'],['delivery','delivery_days']]){
      const rows=(await search(10,0,100,sort)).rows;
      assert.ok(rows.every((r,i)=>i===0||rows[i-1][key]<=r[key]),sort+' respects explicit sort');
    }
    const newest=(await search(10,0,100,'newest')).rows;
    assert.ok(newest.every((r,i)=>i===0||new Date(newest[i-1].created_at)>=new Date(r.created_at)));
    const cheap=await search(10,0,100,'recommended',110);
    assert.equal(cheap.total,10);assert.ok(cheap.rows.every(r=>r.price_jpy<=110));
    assert.equal((await search(10,0,100,'recommended',null,'missing')).total,0);
    await db.exec(`
      update public.listing_boosts set environment='Sandbox' where right(listing_id::text,12)::int=1;
      update public.listing_boosts set status='cancelled' where right(listing_id::text,12)::int=2;
      update public.listing_boosts set ends_at=now() where right(listing_id::text,12)::int=3;
      update public.listing_boosts set starts_at=now()+interval '1 hour' where right(listing_id::text,12)::int=4;
      update public.listings set is_active=false where right(id::text,12)::int=5;
    `);
    const invalid=await db.query(`select public.search_voice_listings_ranked(selected_id=>('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,rotation_epoch=>0) result from generate_series(1,5) n`);
    for(const {result} of invalid.rows.slice(0,4))assert.equal(result.rows[0].boost_plan,null);
    assert.equal(invalid.rows[4].result.total,0,'hidden listing not returned');
    await db.exec(`insert into public.listing_boosts select id,'platinum',now()-interval '1 day',now()+interval '1 day','active','Production' from public.listings where right(id::text,12)::int=81;`);
    const overlap=await db.query(`select public.search_voice_listings_ranked(selected_id=>'00000000-0000-4000-8000-000000000081') result`);
    assert.equal(overlap.rows[0].result.rows[0].boost_plan,'platinum','strongest active plan wins');
    const legacy=await db.query(`select public.search_voice_listings() result`);
    assert.equal(legacy.rows[0].result.rows[0].boost_plan,'platinum','old clients retain tier priority');
  } finally { await db.close(); }
});
