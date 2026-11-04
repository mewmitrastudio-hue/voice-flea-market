import test from 'node:test';
import assert from 'node:assert/strict';
import {jobDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',job='00000000-0000-4000-8000-000000000010',application='00000000-0000-4000-8000-000000000011',attempt='00000000-0000-4000-8000-000000000012';
async function contract(db){
 await db.exec(`insert into jobs(id,buyer_id,title,budget_jpy,status) values('${job}','${buyer}','Job voice',1500,'open');grant select,insert,update on applications,jobs to authenticated;set role authenticated;set request.jwt.claim.sub='${seller}';`);
 await db.query("insert into applications(id,job_id,applicant_id,status) values($1,$2,$3,'pending')",[application,job,seller]);
 await db.exec(`set request.jwt.claim.sub='${buyer}'`);await db.query("update applications set status='accepted' where id=$1",[application]);
 const c=(await db.query("insert into conversations(job_id,buyer_id,seller_id) values($1,$2,$3) returning *",[job,buyer,seller])).rows[0];
 await db.exec("reset role;set request.jwt.claim.sub=''");return c;
}
test('accepted contract terms are server-owned, frozen and bound to the job buyer and seller',async()=>{
 const db=await jobDatabase();try{
  await contract(db);const app=(await db.query('select * from applications')).rows[0];assert.equal(app.agreed_price_jpy,1500);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${seller}'`);
  await assert.rejects(db.query('update applications set agreed_price_jpy=50 where id=$1',[application]),/server-owned/);
  await assert.rejects(db.query('update applications set proposed_price_jpy=50 where id=$1',[application]),/cannot change/);
  await db.exec("reset role;set request.jwt.claim.sub=''");
  await assert.rejects(db.query('select public.prepare_job_checkout($1,$2,$3)',[other,application,'acct_seller']),/unavailable/);
  const q=(await db.query('select public.prepare_job_checkout($1,$2,$3) q',[buyer,application,'acct_seller'])).rows[0].q;
  assert.equal(q.amount_jpy,1500);assert.equal(q.listing_id,null);assert.equal(q.job_id,job);assert.equal(q.job_application_id,application);
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);await assert.rejects(db.query("update applications set status='rejected' where id=$1",[application]),/Resolve/);
  await db.exec("reset role;set request.jwt.claim.sub=''");
  await assert.rejects(db.query("select public.prepare_job_voice_iap_order($1,$2,$3,'Sandbox')",[buyer,application,attempt]),/existing Web purchase/);
 }finally{await db.close();}
});
test('manual job authorization attaches to the existing unpaid chat and cannot be paid twice',async()=>{
 const db=await jobDatabase();try{
  const c=await contract(db);const q=(await db.query('select public.prepare_job_checkout($1,$2,$3) q',[buyer,application,'acct_seller'])).rows[0].q;
  await db.query('update voice_flea_private.checkout_reservations set session_id=$1 where id=$2',['cs_test_job',q.reservation_id]);
  const s={reservation_id:q.reservation_id,job_id:job,job_application_id:application,buyer_id:buyer,seller_id:seller,amount_jpy:1500,stripe_payment_intent_id:'pi_job',stripe_charge_id:'ch_job',stripe_checkout_session_id:'cs_test_job',stripe_livemode:false,stripe_destination:'acct_seller',stripe_reconciled_at:new Date().toISOString(),authorization_expires_at:new Date(Date.now()+86400000).toISOString()};
  await db.query('select public.record_stripe_authorization($1)',[s]);await db.query('select public.record_stripe_authorization($1)',[s]);
  const chats=(await db.query('select * from conversations')).rows;assert.equal(chats.length,1);assert.equal(chats[0].id,c.id);assert.ok(chats[0].payment_id);
  assert.equal((await db.query('select status from jobs')).rows[0].status,'in_progress');
  await assert.rejects(db.query('select public.prepare_job_checkout($1,$2,$3)',[buyer,application,'acct_seller']));
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${buyer}'`);await assert.rejects(db.query("update applications set status='rejected' where id=$1",[application]),/Resolve/);
  await db.exec(`set request.jwt.claim.sub='${seller}'`);await db.query("update conversations set delivery_status='submitted',delivery_path=id::text||'/voice.m4a' where id=$1",[c.id]);
  await db.exec("reset role;set request.jwt.claim.sub=''");
  await db.query('select public.prepare_delivery_acceptance($1,$2)',[buyer,c.id]);
  await db.exec("update payments set status='paid',stripe_reconciled_at=clock_timestamp()");
  await db.query("select public.finalize_delivery_acceptance($1,$2,'tr_job')",[buyer,c.id]);
  assert.equal((await db.query('select status from jobs')).rows[0].status,'closed');
 }finally{await db.close();}
});
test('Apple job purchase requires an enabled exact price, retains an exact job payment and reuses its chat',async()=>{
 const db=await jobDatabase();try{
  const c=await contract(db);
  const prepare=()=>db.query("select public.prepare_job_voice_iap_order($1,$2,$3,'Sandbox') q",[buyer,application,attempt]);
  await assert.rejects(prepare(),/Apple product not ready/);await db.exec("update voice_flea_private.voice_iap_products set sandbox_enabled=true where amount_jpy=1500");
  const order=(await prepare()).rows[0].q;assert.equal(order.amountJpy,1500);
  const apply=()=>db.query("select public.apply_verified_apple_voice($1,'987654321','com.ayuhide.koenofurima.voice.jpy1500','Sandbox',now(),1500000,'JPY',false,$2) r",[order.orderId,buyer]);
  const paid=(await apply()).rows[0].r;assert.equal(paid.conversationId,c.id);assert.equal((await apply()).rows[0].r.paymentId,paid.paymentId);
  const p=(await db.query('select * from payments')).rows[0];assert.equal(p.job_id,job);assert.equal(p.job_application_id,application);assert.equal(p.listing_id,null);assert.equal(p.seller_amount_jpy,null);assert.equal(p.payment_channel,'ios');
 }finally{await db.close();}
});

test('a late verified Apple job receipt is retained after account unavailability without reopening a chat',async()=>{
 const db=await jobDatabase();try{
 await contract(db);await db.exec("update voice_flea_private.voice_iap_products set sandbox_enabled=true where amount_jpy=1500");
 const order=(await db.query("select public.prepare_job_voice_iap_order($1,$2,$3,'Sandbox') q",[buyer,application,attempt])).rows[0].q;
 await db.query('insert into disabled_accounts values($1)',[seller]);
 const paid=(await db.query("select public.apply_verified_apple_voice($1,'987654322','com.ayuhide.koenofurima.voice.jpy1500','Sandbox',now(),1500000,'JPY',false,$2) r",[order.orderId,buyer])).rows[0].r;
 assert.ok(paid.paymentId);assert.equal(paid.conversationId,null);assert.equal((await db.query('select payment_id from conversations')).rows[0].payment_id,null);assert.equal((await db.query('select status from payments')).rows[0].status,'paid');
 }finally{await db.close();}
});
