import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {dispatchStripeRefund,stripeRefundTransport} from '../_shared/stripe-refund-dispatch.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 try{
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')?.trim();
  const adminId=Deno.env.get('ADMIN_USER_ID')?.trim();
  const url=Deno.env.get('SUPABASE_URL');
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!stripeKey||!adminId||!url||!key)return json({error:'返金のサーバー設定を確認できません。'},503);
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return json({error:'ログインしてください。'},401);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user||user.deleted_at)return json({error:'再ログインしてください。'},401);
  if(user.id!==adminId)return json({error:'運営専用です。'},403);
  const body=await req.json().catch(()=>null);
  const id=String(body?.payment_id||'');
  if(!/^[0-9a-f-]{36}$/i.test(id))return json({error:'決済IDを確認してください。'},400);
  if(Deno.env.get('STRIPE_REFUND_DISPATCH_ENABLED')!=='true'||!/^(sk|rk)_(live|test)_/.test(stripeKey))return json({error:'返金の送信は安全確認のため停止しています。'},503);
  const result=await dispatchStripeRefund({db:admin,stripe:stripeRefundTransport(stripeKey),paymentId:id,origin:'manual',actor:user.id,
    live:/^(sk|rk)_live_/.test(stripeKey),platformId:Deno.env.get('STRIPE_DISPUTE_PLATFORM_ACCOUNT_ID')});
  return json(result,result.review_required?202:200);
 }catch(error){console.error('REFUND_FAILED',{name:error?.name});return json({error:'返金の結果を確認できません。新しい返金を送らず、Stripeの返金状況と操作記録を照合してください。'},503);}
});

