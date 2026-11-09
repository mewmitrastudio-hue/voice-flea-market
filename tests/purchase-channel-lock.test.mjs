import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptDatabase} from './fixtures/receipt-database.mjs';
const buyer='00000000-0000-4000-8000-000000000001',seller='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',listing='00000000-0000-4000-8000-000000000004',attempt='00000000-0000-4000-8000-000000000005';
const apple=(db,actor=buyer)=>db.query('select public.prepare_voice_iap_order($1,$2,$3,$4) r',[actor,listing,attempt,'Sandbox']);
const web=(db,actor=buyer)=>db.query('select public.prepare_voice_checkout($1,$2,$3) r',[actor,listing,'acct_seller']);
test('an unresolved Apple order blocks Web even after days, without deleting or changing the order',async()=>{
 const db=await receiptDatabase();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');
  assert.equal((await apple(db)).rows[0].r.sellerId,seller);await db.exec("update voice_flea_private.voice_iap_orders set created_at=now()-interval '30 days'");
  await assert.rejects(web(db),/other channel/);assert.equal((await db.query('select count(*)::int n from voice_flea_private.voice_checkout_intents')).rows[0].n,0);
  assert.equal((await db.query('select state from voice_flea_private.voice_iap_orders')).rows[0].state,'prepared');
  await apple(db);await web(db,other);
 }finally{await db.close();}
});
test('an unresolved Web checkout blocks Apple; only confirmed reservation completion releases it',async()=>{
 const db=await receiptDatabase();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');
  const first=(await web(db)).rows[0].r;assert.equal((await web(db)).rows[0].r.reservation_id,first.reservation_id);
  await assert.rejects(apple(db),/other channel/);
  await db.query('select public.finish_checkout_reservation($1)',[first.reservation_id]);await apple(db);
  await db.exec('set role authenticated');await assert.rejects(web(db),/permission denied/);await assert.rejects(apple(db),/permission denied/);
 }finally{await db.close();}
});
test('Apple cannot bypass an existing authorization or unresolved refund',async()=>{
 const db=await receiptDatabase();try{
  await db.exec('update voice_flea_private.voice_iap_products set sandbox_enabled=true');
  await db.query("insert into payments(buyer_id,seller_id,listing_id,amount_jpy,status) values($1,$2,$3,1000,'authorized')",[buyer,seller,listing]);
  await assert.rejects(apple(db),/requires attention/);
  await db.exec("update payments set status='partially_refunded'");await assert.rejects(apple(db),/requires attention/);
  await assert.rejects(web(db),/requires attention/);
  await db.exec("update payments set status='canceled'");await apple(db);
 }finally{await db.close();}
});
