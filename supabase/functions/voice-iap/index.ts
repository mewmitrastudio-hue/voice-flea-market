import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {appleConfig,verifiedTransaction,applyTransaction} from '../_shared/apple.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 try{
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return json({error:'ログインしてください。'},401);
  // Bound payloads before JSON parsing, also when Content-Length is absent.
  const reader=req.body?.getReader();if(!reader)return json({error:'操作を確認できません。'},400);
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>35000){await reader.cancel();return json({error:'購入情報が大きすぎます。'},413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return json({error:'操作を確認できません。'},400);}
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return json({error:'再ログインしてください。'},401);
  if(body?.action==='verify'){
   if(typeof body.signedTransaction!=='string'||body.signedTransaction.length>30000)return json({error:'購入情報を読み取れません。'},400);
   const tx=await verifiedTransaction(body.signedTransaction);
   if(!/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(tx.productId))return json({error:'音声の購入情報ではありません。'},400);
   const result=await applyTransaction(admin,tx,user.id);
   return json({success:true,...result});
  }
  if(body?.action!=='prepare'||!uuid(body.listingId)||!uuid(body.attemptId))return json({error:'出品を選択してください。'},400);
  // Reconciliation above remains available even after new sales are disabled.
  if(Deno.env.get('VOICE_IAP_ENABLED')!=='true')return json({error:'Appleでの音声購入はまだ開始していません。',code:'voice_iap_not_ready'},409);
  appleConfig();
  const environment=Deno.env.get('VOICE_IAP_ENVIRONMENT')==='Production'?'Production':'Sandbox';
  const {data,error}=await admin.rpc('prepare_voice_iap_order',{owner_id:user.id,listing:body.listingId,attempt:body.attemptId,tx_environment:environment});
  if(error)return json({error:'この出品のApple購入設定を確認できません。購入は開始していません。'},409);
  return json(data);
 }catch(error){console.error('VOICE_IAP_FAILED',{name:error?.name,code:error?.code});return json({error:'購入を確認できません。購入済みの場合は再購入せず「音声購入の反映を確認」を押してください。'},503);}
});
