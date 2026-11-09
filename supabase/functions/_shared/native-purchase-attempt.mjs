export async function nativeAttempt(admin,actor,operation,fields={}){
 const {data,error}=await admin.rpc('native_purchase_attempt',{actor,operation,
  requested_order:fields.orderId??null,sku:fields.productId??null,tx_environment:fields.environment??null,
  price_jpy:fields.amountJpy??null,tx_id:fields.transactionId??null,requested_nonce:fields.attemptNonce??null,requested_signed:fields.signedTransaction??null});
 if(error||!data)throw Error('NATIVE_ATTEMPT_UNCONFIRMED');
 return data;
}
