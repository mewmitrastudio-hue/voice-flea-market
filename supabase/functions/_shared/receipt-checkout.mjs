export async function createReceiptCheckout(stripe,quote){
 const reservation=quote.reservation_id;
 const metadata={listing_id:quote.listing_id,buyer_id:quote.buyer_id,seller_id:quote.seller_id,reservation_id:reservation,capture_flow:'receipt-v1'};
 const suffix=String(reservation).replaceAll('-','').slice(0,8).replace(/[0-9a-f]/g,x=>'abcdefghijklmnop'[parseInt(x,16)]);
 return stripe.checkout.sessions.create({mode:'payment',locale:'ja',allowed_payment_method_types:['card'],integration_identifier:'koefurima_receipt_'+suffix,
  success_url:'https://koe-furima.com/?checkout=success&session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://koe-furima.com/?checkout=cancel',client_reference_id:quote.listing_id,
  line_items:[{quantity:1,price_data:{currency:'jpy',unit_amount:quote.amount_jpy,product_data:{name:quote.title||'声のフリマ商品'}}}],
  custom_text:{submit:{message:'ここでは購入代金を与信します。納品の受取確認後に決済を確定します。与信には期限があります。'}},metadata,
  payment_intent_data:{capture_method:'manual',application_fee_amount:Math.round(quote.amount_jpy*0.15),transfer_data:{destination:quote.stripe_destination},metadata},
 },{idempotencyKey:'checkout:'+reservation});
}
