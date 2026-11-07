import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {profileColumns as columns,legacy43OwnerQuery} from './fixtures/profile-privacy-contract.mjs';
const sql=fs.readFileSync(new URL('../supabase/proposals/profile-anon-mitigation.sql',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
async function fixture(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create table profiles(${columns.map(c=>c+' text').join(',')});alter table profiles enable row level security;create policy profiles_public_read on profiles for select using(true);grant select on profiles to anon,authenticated;insert into profiles(id,display_name,stripe_account_id) values('owner','Owner','acct_fixture');`);return db;}
test('anon mitigation preserves explicit build43 public columns and authenticated owner wildcard',async()=>{
 const db=await fixture();try{await db.exec(sql);await db.exec('set role anon');
 for(const match of app.matchAll(/from\('profiles'\)\s*\.select\('([^']+)'\)/g))if(match[1]!=='*') await db.query('select '+match[1]+' from profiles');
 await assert.rejects(db.query('select stripe_account_id from profiles'),/permission denied/);
 await db.exec('reset role;set role authenticated');assert.equal((await db.query("select * from profiles where id='owner'")).rows[0].stripe_account_id,'acct_fixture');
 // Explicitly document remaining vulnerability: this is NOT a complete privacy fix.
 assert.equal((await db.query('select stripe_account_id from profiles')).rows[0].stripe_account_id,'acct_fixture');
 }finally{await db.close();}
});
test('full authenticated column revoke breaks build43 wildcard as predicted',async()=>{const db=await fixture();try{
 await db.exec('revoke select on profiles from authenticated;grant select(id,display_name) on profiles to authenticated;set role authenticated');
 await assert.rejects(db.query("select * from profiles where id='owner'"),/permission denied/);
 assert.match(legacy43OwnerQuery,/from\('profiles'\)\.select\('\*'\)\.eq\('id',currentUser.id\)/);
 }finally{await db.close();}});
test('unexpected PUBLIC inheritance aborts entire mitigation transaction',async()=>{const db=await fixture();try{
 await db.exec('grant select on profiles to public');await assert.rejects(db.exec(sql),/Inherited\/PUBLIC grant/);await db.exec('rollback');
 assert.equal((await db.query("select has_table_privilege('anon','profiles','SELECT') as ok")).rows[0].ok,true);
 }finally{await db.close();}});
