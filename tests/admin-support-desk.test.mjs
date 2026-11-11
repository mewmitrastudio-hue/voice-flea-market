import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {PGlite} from '@electric-sql/pglite';
const op='00000000-0000-4000-8000-000000000001',member='00000000-0000-4000-8000-000000000002';
test('support desk is operator-only, includes closed history, searches literal text and paginates tied timestamps beyond 100',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema voice_flea_private;
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth,voice_flea_private to authenticated;
  create function voice_flea_private.is_moderator() returns boolean language sql stable as $$select auth.uid()='${op}'::uuid$$;
  create function voice_flea_private.account_available(actor uuid) returns boolean language sql as $$select actor is not null$$;
  create table auth.users(id uuid,email text,deleted_at timestamptz);insert into auth.users values('${member}','member@example.invalid',null);
  create table support_inquiries(id uuid primary key,user_id uuid,category text,subject text,message text,status text,created_at timestamptz,reply_email text);
  alter table support_inquiries enable row level security;grant select on support_inquiries to authenticated;create policy own on support_inquiries to authenticated using(user_id=auth.uid());
  create table voice_flea_private.app_mail_outbox(id uuid,support_inquiry_id uuid,kind text,state text,provider_event text,created_at timestamptz);
  insert into support_inquiries select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${member}','support','Inquiry '||n,case when n=1 then '100% literal' else 'Question' end,case when n%3=0 then 'closed' when n%3=1 then 'open' else 'reviewing' end,'2026-10-24T00:00:00Z',null from generate_series(1,1250)n;`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261024102228_admin_support_desk.sql',import.meta.url),'utf8'));
  assert.equal((await db.query("select has_function_privilege('anon','public.admin_support_inquiries(text,text,timestamptz,uuid)','execute') ok")).rows[0].ok,false);
  assert.equal((await db.query("select prosecdef d from pg_proc where oid='public.admin_support_inquiries(text,text,timestamptz,uuid)'::regprocedure")).rows[0].d,false);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${member}'`);await assert.rejects(db.query('select public.admin_support_inquiries()'),/Operator access required/);
  await db.exec(`set request.jwt.claim.sub='${op}'`);
  const read=async(status='all',q='',c=null)=>(await db.query('select public.admin_support_inquiries($1,$2,$3,$4) r',[status,q,c?.created_at||null,c?.id||null])).rows[0].r;
  let p=await read();assert.equal(p.rows.length,10);assert.equal(p.summary.total,1250);const ids=p.rows.map(x=>x.id);
  while(p.has_more){p=await read('all','',p.rows.at(-1));ids.push(...p.rows.map(x=>x.id));}assert.equal(ids.length,1250);assert.equal(new Set(ids).size,1250);
  assert.ok((await read('closed')).rows.every(x=>x.status==='closed'));
  assert.equal((await read('all','100%')).rows.length,1);assert.equal((await read('all','member@example.invalid')).rows.length,10);
  await assert.rejects(db.query("select public.admin_support_inquiries('all','',now(),null)"),/Invalid support filter/);
 }finally{await db.close()}
});
test('support desk keeps loaded history on failed next page and discards responses after account switches',async()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');const nodes=new Map(['adminSupportItems','adminSupportMore','adminSupportMsg','adminSupportSummary','adminSupportSearch','adminSupportStatus'].map(id=>[id,{value:id==='adminSupportStatus'?'all':'',textContent:'',innerHTML:'',disabled:false,classList:{toggle(){},remove(){}}}]));
 let calls=0,resolve;const cursors=[];const row={id:'one',created_at:'2026',subject:'<private>',message:'<content>',status:'open',reply_email:'private@example.invalid'};
 const c={currentUser:{id:op},isVoiceFleaAdmin:()=>c.currentUser?.id===op,sb:{rpc:async(name,args)=>{cursors.push(args);calls++;return calls===2?{error:true}:{data:{rows:[{...row,id:calls===1?'one':'two'}],summary:{total:2},has_more:calls===1}};}},document:{getElementById:id=>nodes.get(id)},window:{addEventListener(){}},clearTimeout(){},setTimeout(){},info(){},esc:s=>String(s).replaceAll('<','&lt;'),formatJpDateTime:x=>x,mailStatusLabel:()=> 'ack'};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('let adminSupportRevision='),html.indexOf('let adminMailRevision='))+'\nthis.rows=()=>adminSupportRows;',c);
 await c.loadAdminSupportDesk();await c.loadAdminSupportDesk(true);assert.equal(c.rows().length,1);await c.loadAdminSupportDesk(true);assert.equal(c.rows().length,2);assert.deepEqual(cursors[1],cursors[2]);assert.match(nodes.get('adminSupportItems').innerHTML,/&lt;private>/);
 c.sb.rpc=()=>new Promise(r=>resolve=r);const pending=c.loadAdminSupportDesk();c.currentUser={id:member};c.resetAdminSupportDesk();resolve({data:{rows:[row],summary:{},has_more:false}});await pending;assert.equal(c.rows().length,0);assert.equal(nodes.get('adminSupportItems').innerHTML,'');
});

test('support replies open a draft for a single mailbox and do not include inquiry text',()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const context=vm.createContext({});
 vm.runInContext(html.slice(html.indexOf('function supportReplyLink('),html.indexOf('function renderAdminSupportRows(')),context);
 const link=context.supportReplyLink('reader+test@example.invalid',member);
 assert.match(link,/^mailto:reader%2Btest@example\.invalid\?subject=/);
 assert.match(decodeURIComponent(link),/受付番号/);
 assert.doesNotMatch(link,/[?&](body|cc|bcc)=/);
 for(const invalid of ['a@example.invalid,b@example.invalid','a@example.invalid\r\nBcc: x@example.invalid','a@example.invalid?bcc=x@example.invalid','']){
  assert.equal(context.supportReplyLink(invalid,member),'');
 }
});

test('competing status changes on one inquiry submit once and closing the desk discards feedback',async()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const response=Promise.withResolvers(),calls=[],notices=[];
 const context=vm.createContext({currentUser:{id:op},isVoiceFleaAdmin:()=>true,
  sb:{rpc:(_,payload)=>{calls.push(payload);return response.promise;}},
  document:{getElementById:()=>({classList:{remove(){}}})},window:{addEventListener(){}},
  location:{hash:''},clearTimeout(){},info:(...args)=>notices.push(args),
 });
 vm.runInContext(html.slice(html.indexOf('let adminSupportRevision='),html.indexOf('let adminMailRevision=')),context);
 const buttons=[{disabled:true},{disabled:false}];
 const control={closest:()=>({querySelectorAll:()=>buttons})};
 const write=context.updateSupportInquiryStatus(member,'closed',control);
 await context.updateSupportInquiryStatus(member,'reviewing',control);
 assert.equal(calls.length,1);
 assert.deepEqual(buttons.map(x=>x.disabled),[true,true]);
 context.closeAdminSupportDesk();
 response.reject(new Error('Network disconnected'));
 await write;
 assert.deepEqual(buttons.map(x=>x.disabled),[true,false]);
 assert.equal(notices.length,1);
});

test('operator menu requires a server grant bound to the current session',async()=>{
 const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/VOICE_FLEA_ADMIN_USER_ID/);
 const calls=[];
 let response=Promise.withResolvers();
 const context=vm.createContext({currentUser:{id:'original'},authUIRevision:1,authReloadPending:false,
  sb:{rpc:()=>response.promise},document:{getElementById:()=>({classList:{toggle:(_name,hidden)=>calls.push(hidden)}})},
 });
 vm.runInContext(html.slice(html.indexOf('let operatorAccessOwner='),html.indexOf('async function openModerationQueue(')),context);
 assert.equal(context.isVoiceFleaAdmin(),false);
 const old=context.refreshOperatorAccess('original',1);
 context.currentUser={id:'current'};
 context.authUIRevision=2;
 response.resolve({data:true});
 await old;
 assert.equal(context.isVoiceFleaAdmin(),false);
 assert.equal(calls.length,0);
 response=Promise.withResolvers();
 const check=context.refreshOperatorAccess('current',2);
 response.resolve({data:true});
 await check;
 assert.equal(context.isVoiceFleaAdmin(),true);
 assert.ok(calls.every(hidden=>hidden===false));
 context.authReloadPending=true;
 assert.equal(context.isVoiceFleaAdmin(),false);
});
