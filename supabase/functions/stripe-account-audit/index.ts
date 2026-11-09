import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@22.6.0';
import {stripeAccountAudit} from '../_shared/stripe-account-audit.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 try{
  const adminId=Deno.env.get('ADMIN_USER_ID')?.trim();
  const url=Deno.env.get('SUPABASE_URL');
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!adminId||!url||!key)return json({error:'照合のサーバー設定を確認できません。'},503);
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return json({error:'ログインしてください。'},401);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error}=await db.auth.getUser(token);
  if(error||!user)return json({error:'再ログインしてください。'},401);
  if(user.id!==adminId)return json({error:'運営アカウント専用です。'},403);
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')?.trim()||'';
  if(!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(stripeKey))return json({error:'Stripeのサーバー設定を確認できません。'},503);
  // Fixed read operations only. Ignore request bodies, account IDs and key overrides.
  const stripe=new Stripe(stripeKey,{apiVersion:'2026-08-26.dahlia',maxNetworkRetries:1,timeout:15000});
  const audit=await stripeAccountAudit(stripe,/^(sk|rk)_live_/.test(stripeKey));
  return json({success:true,...audit});
 }catch{
  // Never send upstream error text, credentials, bank details or stack traces.
  return json({error:'Stripeの接続口座を照合できません。権限や接続状態を確認してください。'},503);
 }
});
