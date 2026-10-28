import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {captureReceipt,cancelReceiptAuthorization,verifyReceiptPayment} from '../_shared/receipt-capture.mjs';
import {createReceiptCheckout} from '../_shared/receipt-checkout.mjs';
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
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default,stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!url||!key||!/^(sk|rk)_(test|live)_/.test(stripeKey))return reply({error:'決済設定を確認できません。'},503);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user)return reply({error:'再ログインしてください。'},401);
  const {data:plan,error}=await db.rpc('inspect_delivery_renewal',{actor:user.id,trade_id:tradeId});
  if(error||!plan?.payment)return reply({error:'元の取引と支払いを確認してください。'},409);
  const payment=plan.payment,live=/^(sk|rk)_live_/.test(stripeKey);
  const client=new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
  const stripe={get:async(path:string,params:any):Promise<any>=>path.startsWith('transfers/')?client.transfers.retrieve(path.split('/')[1]):client.paymentIntents.retrieve(path.split('/')[1],params),
   capture:async(id:string,params:any,idempotencyKey:string)=>client.paymentIntents.capture(id,params,{idempotencyKey}),
   cancel:async(id:string,params:any,idempotencyKey:string)=>client.paymentIntents.cancel(id,params,{idempotencyKey})};
  const pi=await stripe.get('payment_intents/'+payment.stripe_payment_intent_id,{expand:['latest_charge']});
  if(pi.status==='succeeded'){
   const snapshot=await captureReceipt({payment,stripe,live});
   const {error}=await db.rpc('record_stripe_payment_snapshot',{snapshot});if(error)throw new Error('capture_persistence_pending');
   return reply({success:true,alreadyCaptured:true});
  }
  if(pi.status==='requires_capture'){
   const charge=verifyReceiptPayment(pi,payment,live),expires=charge.payment_method_details?.card?.capture_before;
   if(!Number.isSafeInteger(expires)||expires*1000>Date.now())return reply({error:'現在の与信は有効です。再認証は不要です。元の取引をご確認ください。'},409);
  }else if(pi.status!=='canceled')return reply({error:'支払い状況を確認中です。再購入せず時間をおいて確認してください。'},409);
  await cancelReceiptAuthorization({payment,stripe,live});
  const account=await client.v2.core.accounts.retrieve(payment.stripe_destination,{include:['configuration.recipient','requirements']});
  const cap=account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
  if(account.id!==payment.stripe_destination||account.livemode!==live||cap!=='active'||(account.requirements?.entries||[]).some((x:any)=>x.awaiting_action_from==='user'&&['currently_due','past_due'].includes(x.minimum_deadline?.status)))return reply({error:'出品者の受取設定を確認する必要があります。運営へお問い合わせください。'},409);
  const {data:quote,error:quoteError}=await db.rpc('prepare_voice_renewal_checkout',{actor:user.id,trade_id:tradeId});
  if(quoteError||!quote?.reservation_id)return reply({error:'再認証の準備を確認できません。再購入せず元の取引をご確認ください。'},409);
  const session=await createReceiptCheckout(client,quote);
  if(!/^cs_[A-Za-z0-9_]+$/.test(session.id)||session.livemode!==live)throw new Error('checkout_unconfirmed');
  if(session.status==='expired'){await db.rpc('finish_checkout_reservation',{reservation:quote.reservation_id,session:session.id});return reply({error:'認証画面の有効期限が切れました。もう一度お試しください。'},409);}
  if(session.status==='complete'){
   const {error}=await db.rpc('record_checkout_session',{reservation:quote.reservation_id,session:session.id});if(error)throw new Error('checkout_persistence_pending');
   return reply({success:true,sessionId:session.id,listingId:payment.listing_id,awaitingReconciliation:true});
  }
  if(!/^cs_[A-Za-z0-9_]+$/.test(session.id)||session.livemode!==live||!session.url||new URL(session.url).hostname!=='checkout.stripe.com'||new URL(session.url).protocol!=='https:')throw new Error('checkout_unconfirmed');
  const {error:saveError}=await db.rpc('record_checkout_session',{reservation:quote.reservation_id,session:session.id});if(saveError)throw new Error('checkout_persistence_pending');
  return reply({success:true,sessionId:session.id,listingId:payment.listing_id,url:session.url});
 }catch(error){
  if(error instanceof SyntaxError)return reply({error:'送信内容を確認してください。'},400);
  console.warn('REAUTHORIZATION_UNCONFIRMED',{name:error instanceof Error?error.name:'unknown'});
  return reply({error:'再認証の結果を確認できません。新しく購入せず、元の取引から再認証を再試行してください。'},503);
 }
});
