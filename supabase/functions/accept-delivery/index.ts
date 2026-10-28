import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {captureReceipt,ReceiptError} from '../_shared/receipt-capture.mjs';
import {appleConfig,applyTransaction} from '../_shared/apple.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return reply({error:'POSTで送信してください。'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return reply({error:'ログインしてください。'},401);
 try{
  const raw=await req.text();if(raw.length>4096)return reply({error:'送信内容が大きすぎます。'},413);
  const body=JSON.parse(raw),tradeId=body?.conversationId;
  if(typeof tradeId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tradeId))return reply({error:'取引を確認してください。'},400);
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!url||!key)return reply({error:'受取確認の設定を確認できません。'},503);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return reply({error:'再ログインしてください。'},401);
  const {data:prepared,error:prepareError}=await admin.rpc('prepare_delivery_acceptance',{actor:user.id,trade_id:tradeId});
  if(prepareError||!prepared?.payment)return reply({error:'納品・支払い・与信期限を確認してください。受取は完了していません。'},409);
  if(prepared.alreadyAccepted)return reply({success:true,conversation:prepared.conversation,alreadyAccepted:true});
  const payment=prepared.payment;let transfer:string|null=null;
  if(payment.payment_channel==='web'){
   const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
   if(!/^(sk|rk)_(test|live)_/.test(stripeKey))return reply({error:'決済設定を確認できません。'},503);
   const client=new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
   const stripe={
    get:async(path:string,params:any)=>path.startsWith('transfers/')?client.transfers.retrieve(path.split('/')[1]):client.paymentIntents.retrieve(path.split('/')[1],params),
    capture:async(id:string,params:any,idempotencyKey:string)=>client.paymentIntents.capture(id,params,{idempotencyKey}),
   };
   const snapshot=await captureReceipt({payment,stripe,live:/^(sk|rk)_live_/.test(stripeKey)});
   transfer=snapshot.transfer_id;
   const {error}=await admin.rpc('record_stripe_payment_snapshot',{snapshot});
   if(error)throw new ReceiptError('capture_persistence_pending');
  }else if(payment.payment_channel==='ios'){
   // Re-check with Apple, including revocation, rather than trusting an old client receipt.
   const tx=await appleConfig().verifier.verifiedTransactionById(payment.apple_transaction_id,payment.apple_environment);
   if(tx.productId!=='com.ayuhide.koenofurima.voice.jpy'+payment.amount_jpy||tx.currency!=='JPY'||tx.price!==payment.amount_jpy*1000)throw new ReceiptError('apple_payment_mismatch');
   const result=await applyTransaction(admin,tx,user.id);
   if(result.paymentId!==payment.id||result.revoked)throw new ReceiptError('apple_payment_revoked');
  }else throw new ReceiptError('payment_unavailable');
  const {data:conversation,error}=await admin.rpc('finalize_delivery_acceptance',{actor:user.id,trade_id:tradeId,transfer});
  if(error||!conversation||conversation.delivery_status!=='accepted')throw new ReceiptError('receipt_persistence_pending');
  return reply({success:true,conversation});
 }catch(error){
  if(error instanceof SyntaxError)return reply({error:'送信内容を確認してください。'},400);
  const code=error instanceof ReceiptError?error.code:'receipt_result_unknown';
  console.warn('RECEIPT_NOT_CONFIRMED',{code});
  return reply({error:code==='authorization_expired_or_unavailable'?'与信期限が切れたか、支払いを確認できません。受取は完了していません。再購入せず運営へお問い合わせください。':'受取の完了を確認できません。決済済みの場合も再購入せず、この取引から受取確認を再試行してください。',code},503);
 }
});
