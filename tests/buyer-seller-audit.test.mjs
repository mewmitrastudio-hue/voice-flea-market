import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const buyer='00000000-0000-4000-8000-000000000001';
const seller='00000000-0000-4000-8000-000000000002';
const other='00000000-0000-4000-8000-000000000003';
const payment='00000000-0000-4000-8000-000000000004';
const attempt='00000000-0000-4000-8000-000000000005';
const listing='00000000-0000-4000-8000-000000000006';
test('seller totals are owner-scoped, complete beyond API row limits, and exclude test, unknown and refund records',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to authenticated;
  create table listings(price_jpy integer);insert into listings values(1000);
  create table payments(seller_id uuid,buyer_id uuid,seller_amount_jpy integer,status text,stripe_livemode boolean,stripe_reconciled_at timestamptz,refunded_amount_jpy integer);
  alter table payments enable row level security;grant select on payments to authenticated;
  create policy own on payments for select to authenticated using(seller_id=auth.uid() or buyer_id=auth.uid());
  insert into payments select '${seller}','${buyer}',850,'paid',true,now(),0 from generate_series(1,1200);
  insert into payments values('${seller}','${buyer}',850,'paid',false,now(),0),('${seller}','${buyer}',850,'paid',null,null,null),('${seller}','${buyer}',850,'partially_refunded',true,now(),300),('${other}','${buyer}',999,'paid',true,now(),0);`);
  await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261024083716_seller_finance_verified_summary.sql',import.meta.url),'utf8'));
  await assert.rejects(db.exec('insert into listings values(0)'),/listings_checkout_minimum_price/);
  await db.exec('insert into listings values(50)');
  assert.equal((await db.query("select has_function_privilege('anon','public.seller_finance_summary()','execute') p")).rows[0].p,false);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  const r=(await db.query('select public.seller_finance_summary() result')).rows[0].result;
  assert.deepEqual(r,{count:1200,payout:1020000,unverified:1,test:1,adjusting:1});
  await db.exec(`set request.jwt.claim.sub='${buyer}'`);assert.equal((await db.query('select public.seller_finance_summary() r')).rows[0].r.payout,0);
  await db.exec(`set request.jwt.claim.sub='${other}'`);assert.equal((await db.query('select public.seller_finance_summary() r')).rows[0].r.payout,999);
 }finally{await db.close();}
});
test('listing validation stops unpayable amounts and unsupported delivery dates before uploads or inserts',async()=>{
 const notices=[];let writes=0;
 const c={currentUser:{id:seller},sellTitle:{value:'Voice'},sellDesc:{value:'A voice recording'},sellPrice:{value:'0'},sellDays:{value:'3'},sellAudio:{files:[]},sb:{from:()=>{writes++;throw new Error('unexpected write')},storage:{from:()=>{writes++;throw new Error('unexpected upload')}}},info:(id,text)=>notices.push(text),validWholeNumber:(v,min)=>String(v).trim()!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=min};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function createListing(){'),html.indexOf('/* 購入時のエラーを')),c);
 for(const price of ['0','49','50.5','-1','']){c.sellPrice.value=price;await c.createListing();}
 c.sellPrice.value='50';c.sellDays.value='366';await c.createListing();assert.equal(writes,0);assert.match(notices.at(-1),/365/);assert.ok(notices.some(x=>x.includes('50円')));
});
test('buyer history retry retains already loaded rows and reuses the offset after a network failure',async()=>{
 let calls=0,hasMore=false;const ranges=[],notices=[];
 const button={disabled:true,textContent:'',remove(){hasMore=false}};
 const body={innerHTML:'',querySelector:selector=>selector==='[data-payment-more]'?(hasMore?button:null):{remove(){}},insertAdjacentHTML(_,html){this.innerHTML+=html;if(html.includes('data-payment-more'))hasMore=true}};
 const builder={select(){return this},eq(){return this},in(){return this},order(){return this},async range(a,b){ranges.push([a,b]);calls++;if(calls===2)throw Error('offline');return{data:Array.from({length:calls===1?20:1},(_,i)=>({id:String(i),amount_jpy:1000,status:'paid',paid_at:'2026'})),error:null}}};
 const c={currentUser:{id:buyer},activeFinanceMode:'buyer',sb:{from:()=>builder},document:{getElementById:id=>id==='financeBody'?body:null,querySelector:()=>null},console:{warn(){}},info:(_,message)=>notices.push(message),financeYen:n=>`${n}円`,paymentRefundLabel:()=> '未照合',formatJpDateTime:x=>x,esc:String};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('let buyerFinanceRequest='),html.indexOf('function setStripeConnectUI(')),c);
 await c.loadBuyerFinance();const loaded=body.innerHTML;await c.loadBuyerFinance(true);assert.equal(body.innerHTML,loaded);assert.equal(button.disabled,false);assert.match(notices[0],/履歴を残/);
 await c.loadBuyerFinance(true);assert.deepEqual(ranges,[[0,19],[20,39],[20,39]]);
});
test('trade information never borrows a different repeat purchase or lists a recruitment budget as a paid amount',async()=>{
 const panel={innerHTML:'',classList:{add(){},remove(){}}};let pays=[];
 const c={currentUser:{id:seller},currentConversationId:'trade',document:{getElementById:id=>id==='tradeInfoPanel'?panel:null},
  sb:{from:table=>{const data=table==='profiles'?{display_name:'Buyer'}:table==='listings'?{title:'Voice',price_jpy:9999}:table==='jobs'?{title:'Request',budget_jpy:1500}:pays;
   const q={select(){return this},eq(){return this},in(){return this},order(){return this},limit(){return Promise.resolve({data,error:null})},maybeSingle:async()=>({data,error:null})};return q;}},
  formatJpDateTime:x=>x,isTradeInfoSeen:()=>false,esc:String,paymentStatusLabel:()=> '支払い済み',Date,console:{warn(){}},
 };
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function loadTradeInfoPanel('),html.indexOf('let conversationOpenRequest=')),c);
 const trade={id:'trade',buyer_id:buyer,seller_id:seller,listing_id:listing,created_at:'2026-09-12',delivery_status:'submitted'};
 pays=[{amount_jpy:1000,paid_at:'2026-09-11'},{amount_jpy:2000,paid_at:'2026-09-16'}];await c.loadTradeInfoPanel(trade);
 assert.match(panel.innerHTML,/対応が未照合/);assert.doesNotMatch(panel.innerHTML,/2,000円|9,999円|>購入日<\/div>/);
 pays=[{id:payment,amount_jpy:1000,paid_at:'2026-09-11'}];await c.loadTradeInfoPanel(trade);assert.match(panel.innerHTML,/対応が未照合/);await c.loadTradeInfoPanel({...trade,payment_id:payment});assert.match(panel.innerHTML,/1,000円/);assert.match(panel.innerHTML,/購入日/);
 await c.loadTradeInfoPanel({...trade,listing_id:null,job_id:'job'});assert.match(panel.innerHTML,/募集予算/);assert.match(panel.innerHTML,/支払い完了を示すものではありません/);
});
test('unfinished native iOS normal purchases stop before creating an external Checkout session',async()=>{
 const errors=[];let fetched=0;
 const c={sb:{},currentUser:{id:buyer},window:{Capacitor:{isNativePlatform:()=>true,getPlatform:()=> 'ios'}},showCheckoutError:error=>errors.push(error.message),fetch:()=>{fetched++;throw Error('Unexpected network')},Set,Error};
 vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const checkoutInFlight='),html.indexOf('async function reconcilePendingPurchase(')),c);
 await c.startStripeCheckout(listing);assert.equal(fetched,0);assert.match(errors[0],/iPhone.*準備中/);
});
