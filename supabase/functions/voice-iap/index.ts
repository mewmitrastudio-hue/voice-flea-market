import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {requireRecipient} from '../_shared/recipient-readiness.mjs';
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
  const jobPurchase=body?.action==='prepareJob'&&uuid(body.applicationId);
  if(!(jobPurchase||body?.action==='prepare'&&uuid(body.listingId))||!uuid(body.attemptId))return json({error:'出品を選択してください。'},400);
  // Reconciliation above remains available even after new sales are disabled.
  if(Deno.env.get('VOICE_IAP_ENABLED')!=='true')return json({error:'Appleでの音声購入はまだ開始していません。',code:'voice_iap_not_ready'},409);
  appleConfig();
  const environment=Deno.env.get('VOICE_IAP_ENVIRONMENT')==='Production'?'Production':'Sandbox';
  // Reject an unusable payment environment before creating a durable order.
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!(/^(sk|rk)_live_/.test(stripeKey)?environment==='Production':/^(sk|rk)_test_/.test(stripeKey)&&environment==='Sandbox'))return json({error:'販売・受取環境の設定を確認できません。購入は開始していません。'},409);
  // Resolve the seller from server-owned records before reserving an order.
  // The preparation RPC still revalidates the contract under database locks.
  let sellerId:string;
  if(jobPurchase){
   const {data:application,error}=await admin.from('applications').select('id,job_id,applicant_id,status').eq('id',body.applicationId).maybeSingle();
   if(error||!application||application.status!=='accepted')return json({error:'承認済みの依頼を確認してください。'},409);
   const {data:job,error:jobError}=await admin.from('jobs').select('id,buyer_id,status').eq('id',application.job_id).maybeSingle();
   if(jobError||!job||job.buyer_id!==user.id||job.status!=='open')return json({error:'購入できる依頼を確認してください。'},409);
   sellerId=application.applicant_id;
  }else{
   const {data:listing,error}=await admin.from('listings').select('id,seller_id,is_active').eq('id',body.listingId).maybeSingle();
   if(error||!listing?.is_active)return json({error:'この出品は現在購入できません。'},409);
   sellerId=listing.seller_id;
  }
  if(!uuid(sellerId)||sellerId===user.id)return json({error:'販売者の設定を確認できません。購入は開始していません。'},409);
  try{await requireRecipient({admin,sellerId,stripe:new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000}),live:environment==='Production'});}
  catch{return json({error:'出品者の受取設定が完了していません。購入は開始していません。',code:'seller_not_ready'},409);}
  const {data,error}=await admin.rpc(jobPurchase?'prepare_job_voice_iap_order':'prepare_voice_iap_order',jobPurchase?{owner_id:user.id,application:body.applicationId,attempt:body.attemptId,tx_environment:environment}:{owner_id:user.id,listing:body.listingId,attempt:body.attemptId,tx_environment:environment});
  if(error)return json({error:'この出品のApple購入設定を確認できません。購入は開始していません。'},409);
  if(data?.sellerId!==sellerId)return json({error:'販売者の情報が変更されました。購入は開始していません。'},409);
  return json(data);
 }catch(error){
  if(error?.message==='APPLE_REFUND_REVIEW_HELD')return json({error:'Appleの返金内容を照合中です。金額を確定せず、この取引の新しい納品・受取・送金手続きを保留しています。運営へお問い合わせください。',code:'apple_refund_review_required'},409);
  if(error?.message==='APPLE_REFUND_RECONCILIATION_REQUIRED')return json({error:'Appleの返金内容を確認する必要があります。購入や返金額は確定していません。再購入せず運営へお問い合わせください。',code:'apple_refund_evidence_required'},409);
console.error('VOICE_IAP_FAILED',{name:error instanceof Error?error.name:'unknown'});return json({error:'購入を確認できません。購入済みの場合は再購入せず「音声購入の反映を確認」を押してください。'},503);}
});
