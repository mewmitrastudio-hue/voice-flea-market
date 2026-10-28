import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {createReceiptCheckout} from '../_shared/receipt-checkout.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
function providerFailure(error:unknown){const e=error&&typeof error==='object'?error as {statusCode?:unknown,type?:unknown,name?:unknown}:{};return {status:typeof e.statusCode==='number'?e.statusCode:undefined,type:typeof e.type==='string'?e.type:typeof e.name==='string'?e.name:'unknown'};}
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return json({error:'ログインしてください。'},401);
 try{
  const raw=await req.text();if(raw.length>4096)return json({error:'送信内容が大きすぎます。'},413);
  const body=JSON.parse(raw);if(!uuid(body?.listingId)||!uuid(body?.attemptId))return json({error:'購入情報を確認してください。'},400);
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!url||!key||!/^(sk|rk)_(test|live)_/.test(stripeKey))return json({error:'決済の設定を確認できません。'},503);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await db.auth.getUser(token);
  if(authError||!user)return json({error:'再ログインしてください。'},401);
  // Deploying source does not enable sales. This flag is set only after Sandbox and release checks.
  if(Deno.env.get('STRIPE_RECEIPT_CAPTURE_ENABLED')!=='true')return json({error:'購入機能の更新準備中です。'},503);
  const {data:listing,error:listingError}=await db.from('listings').select('id,seller_id,title,price_jpy,is_active').eq('id',body.listingId).maybeSingle();
  if(listingError)return json({error:'商品を確認できません。'},503);
  if(!listing?.is_active)return json({error:'この出品は現在購入できません。'},404);
  if(listing.seller_id===user.id)return json({error:'自分の出品は購入できません。'},403);
  if(!Number.isSafeInteger(listing.price_jpy)||listing.price_jpy<50)return json({error:'価格を確認できません。'},422);
  const {data:seller,error:sellerError}=await db.from('profiles').select('id,stripe_account_id').eq('id',listing.seller_id).maybeSingle();
  if(sellerError)return json({error:'出品者を確認できません。'},503);
  if(!seller||!/^acct_[A-Za-z0-9]+$/.test(seller.stripe_account_id||''))return json({code:'seller_not_ready',error:'出品者の受取設定が完了していません。'},409);
  const stripe=new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
  const account=await stripe.v2.core.accounts.retrieve(seller.stripe_account_id,{include:['configuration.recipient','requirements']});
  const live=/^(sk|rk)_live_/.test(stripeKey);
  const cap=account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
  const needsAction=(account.requirements?.entries||[]).some((x:any)=>x.awaiting_action_from==='user'&&['currently_due','past_due'].includes(x.minimum_deadline?.status));
  if(account.id!==seller.stripe_account_id||account.livemode!==live||cap!=='active'||needsAction)return json({code:'seller_not_ready',error:'出品者の受取設定を確認する必要があります。'},409);
  const {data:quote,error:reserveError}=await db.rpc('prepare_voice_checkout',{actor:user.id,listing:listing.id,destination:seller.stripe_account_id});
  const reservation=quote?.reservation_id;
  if(reserveError||!reservation)return json({error:'購入手続きを開始できません。再購入せず状況を確認してください。'},409);
  let session;
  try{session=await createReceiptCheckout(stripe,quote);}
  catch(error){
   const failed=providerFailure(error);
   if(failed.status!==undefined&&[400,401,402,403,404,422].includes(failed.status)&&failed.type!=='StripeIdempotencyError')await db.rpc('finish_checkout_reservation',{reservation});
   throw error;
  }
  if(!/^cs_[A-Za-z0-9_]+$/.test(session.id)||session.livemode!==live)return json({error:'購入情報を確認できません。'},503);
  if(session.status==='expired'){
   await db.rpc('finish_checkout_reservation',{reservation,session:session.id});
   return json({error:'購入画面の有効期限が切れました。もう一度お試しください。',code:'checkout_expired_retry'},409);
  }
  if(session.status==='complete'){
   const {error}=await db.rpc('record_checkout_session',{reservation,session:session.id});
   if(error)return json({error:'購入情報を保存できません。再購入せず確認してください。'},503);
   return json({success:true,sessionId:session.id,awaitingReconciliation:true});
  }
  if(!/^cs_[A-Za-z0-9_]+$/.test(session.id)||session.livemode!==live||!session.url||new URL(session.url).hostname!=='checkout.stripe.com'||new URL(session.url).protocol!=='https:')return json({error:'決済画面を確認できません。再購入せず運営へお問い合わせください。'},503);
  const {error}=await db.rpc('record_checkout_session',{reservation,session:session.id});
  if(error)return json({error:'購入情報を保存できませんでした。再購入せず運営へお問い合わせください。'},503);
  return json({success:true,sessionId:session.id,url:session.url});
 }catch(error){
  if(error instanceof SyntaxError)return json({error:'送信内容を確認してください。'},400);
  console.warn('CHECKOUT_NOT_CONFIRMED',providerFailure(error));
  return json({error:'購入画面を準備できませんでした。再購入せず、時間をおいて確認してください。'},503);
 }
});
