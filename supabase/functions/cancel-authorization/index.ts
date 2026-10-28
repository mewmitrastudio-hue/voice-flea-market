import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {cancelReceiptAuthorization} from '../_shared/receipt-capture.mjs';
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
  if(!url||!key)return reply({error:'設定を確認できません。'},503);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return reply({error:'再ログインしてください。'},401);
  const {data:plan,error}=await admin.rpc('prepare_authorization_cancellation',{actor:user.id,trade_id:tradeId});
  if(error||!plan?.payment)return reply({error:'納品前・決済確定前の取引を確認してください。'},409);
  if(plan.state==='canceled')return reply({success:true,state:'canceled'});
  if(!plan.ready)return reply({success:true,state:'requested'});
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!/^(sk|rk)_(test|live)_/.test(stripeKey))return reply({error:'決済設定を確認できません。'},503);
  const client=new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
  await cancelReceiptAuthorization({payment:plan.payment,live:/^(sk|rk)_live_/.test(stripeKey),stripe:{
   get:async(path:string)=>client.paymentIntents.retrieve(path.split('/')[1]),
   cancel:async(id:string,params:any,idempotencyKey:string)=>client.paymentIntents.cancel(id,params,{idempotencyKey}),
  }});
  const {error:saveError}=await admin.rpc('finish_authorization_cancellation',{actor:user.id,trade_id:tradeId});
  if(saveError)throw new Error('cancellation_persistence_pending');
  return reply({success:true,state:'canceled'});
 }catch(error){
  if(error instanceof SyntaxError)return reply({error:'送信内容を確認してください。'},400);
  console.warn('AUTHORIZATION_CANCELLATION_UNCONFIRMED',{name:error instanceof Error?error.name:'unknown'});
  return reply({error:'キャンセルの完了を確認できません。再購入せず、この取引でキャンセル状況を再確認してください。'},503);
 }
});
