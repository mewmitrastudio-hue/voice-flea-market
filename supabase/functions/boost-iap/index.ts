import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {enabled,appleConfig,verifiedTransaction,applyTransaction} from '../_shared/apple.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 try{
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return json({error:'ログインしてください。'},401);
  const url=Deno.env.get('SUPABASE_URL')||'';
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!url||!key)return json({error:'サーバー設定を確認できません。'},503);
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error}=await admin.auth.getUser(token);
  if(error||!user)return json({error:'再ログインしてください。'},401);
  const body=await req.json().catch(()=>null);
  if(body?.action==='status'){
   let ready=enabled();try{appleConfig();}catch{ready=false;}
   return json({enabled:ready,environment:Deno.env.get('BOOST_IAP_ENVIRONMENT')==='Production'?'Production':'Sandbox'});
  }
  // Pending paid transactions can always be reconciled, even after sales are disabled.
  if(body?.action==='verify'){
   if(typeof body.signedTransaction!=='string'||body.signedTransaction.length>30000)return json({error:'購入情報を読み取れません。'},400);
   const tx=await verifiedTransaction(body.signedTransaction);
   const result=await applyTransaction(admin,tx);
   return json({success:true,...result});
  }
  if(body?.action!=='prepare')return json({error:'操作を確認できません。'},400);
  if(!enabled())return json({error:'ブースト購入は準備中です。'},409);
  appleConfig();
  if(!['silver','gold','platinum'].includes(body.plan)||typeof body.listingId!=='string')return json({error:'出品とプランを選択してください。'},400);
  const {data,error:orderError}=await admin.rpc('prepare_boost_order',{owner_id:user.id,listing:body.listingId,tier:body.plan});
  if(orderError)return json({error:'公開中の自分の出品を選択してください。有効なブーストがある場合は期間終了後に購入できます。'},409);
  return json(data);
 }catch(error){console.error('BOOST_IAP_FAILED',{name:error?.name,code:error?.code});return json({error:'購入情報を確認できません。購入済みの場合は再購入せず「購入の反映を確認」を押してください。'},503);}
});
