import {nativePurchaseReceipt} from '../_shared/native-purchase-receipt.mjs';
import {nativeAttempt} from '../_shared/native-purchase-attempt.mjs';
import {nativePurchaseGrant} from '../_shared/native-purchase-grant.mjs';
import {purchaseEnvironments,preparationEnvironment} from '../_shared/iap-environment.mjs';
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
  if(['nativeStatus','nativeBegin','nativeCancel','nativeFinished','nativeDeferFinish'].includes(body?.action)){
   // A normal JWT and nonce do not attest a StoreKit cancellation.
   if(body.action==='nativeCancel')return json({error:'購入の取消を独立に確認できません。記録を保持しています。運営へお問い合わせください。',code:'native_cancellation_unverified'},409);
   if(body.action==='nativeBegin'){
    const gate=typeof body.productId==='string'&&body.productId.includes('.voice.')?'VOICE_IAP_ENABLED':'BOOST_IAP_ENABLED';
    if(Deno.env.get(gate)!=='true')return json({error:'購入は開始していません。'},409);
    const environmentGate=gate==='VOICE_IAP_ENABLED'?'VOICE_IAP_ENVIRONMENT':'BOOST_IAP_ENVIRONMENT';
    try { if(preparationEnvironment(Deno.env.get(environmentGate),body.environment)!==body.environment)throw Error('environment'); }
    catch{return json({error:'Appleの購入環境を確認できません。購入は開始していません。'},409);}
    appleConfig();
   }
   const operation=body.action==='nativeStatus'?'status':body.action==='nativeBegin'?'begin':body.action==='nativeFinished'?'finish':body.action==='nativeDeferFinish'?'defer_finish':'cancel';
   const result=await nativeAttempt(admin,user.id,operation,body);
   return json({success:true,...result});
  }
  if(body?.action==='status'){
   let ready=enabled();try{appleConfig();}catch{ready=false;}
   const environments=purchaseEnvironments(Deno.env.get('BOOST_IAP_ENVIRONMENT'));
   return json({enabled:ready&&environments.length>0,environment:environments.length===1?environments[0]:null,environments});
  }
  // Pending paid transactions can always be reconciled, even after sales are disabled.
  if(body?.action==='verify'){
   if(typeof body.signedTransaction!=='string'||body.signedTransaction.length>30000)return json({error:'購入情報を読み取れません。'},400);
   const tx=await verifiedTransaction(body.signedTransaction);
   if(!['silver','gold','platinum'].some(plan=>tx.productId===`com.ayuhide.koenofurima.boost.${plan}`))return json({error:'ブーストの購入情報ではありません。'},400);
   const result=await applyTransaction(admin,tx,user.id);
   const nativeReceipt=body.nativeProtocol===3?nativePurchaseReceipt({tx,ownerId:user.id,result,backendUrl:Deno.env.get('SUPABASE_URL')!}):null;
   if(result.reviewRequired===true||result.fulfillmentGranted===false)return json({success:false,code:'native_payment_review_required',error:'購入・返金の記録を保存しました。追加のサービス提供や返金は未確定です。再購入せず運営の確認をお待ちください。',receiptClassification:result.receiptClassification,financiallyRecorded:result.financiallyRecorded===true,revoked:result.revoked===true,...(nativeReceipt?{nativeReceipt}:{})},409);
   const nativeState=body.nativeProtocol===1?await nativeAttempt(admin,user.id,'settle',{orderId:tx.appAccountToken,productId:tx.productId,environment:tx.environment,amountJpy:tx.price/1000,transactionId:tx.transactionId,signedTransaction:body.signedTransaction}):null;
   return json({success:true,...result,...(nativeReceipt?{nativeReceipt}:{}),...(body.nativeProtocol===1?{nativeGrant:{...nativePurchaseGrant({tx,ownerId:user.id,result,backendUrl:Deno.env.get('SUPABASE_URL')!}),attemptNonce:nativeState?.attemptNonce??null}}:{})});
  }
  if(body?.action!=='prepare')return json({error:'操作を確認できません。'},400);
  if(!enabled())return json({error:'ブースト購入は準備中です。'},409);
  appleConfig();
  if(!['silver','gold','platinum'].includes(body.plan)||typeof body.listingId!=='string')return json({error:'出品とプランを選択してください。'},400);
  let environment:string;try{environment=preparationEnvironment(Deno.env.get('BOOST_IAP_ENVIRONMENT'),body.storeKitEnvironment);}catch{return json({error:'Appleの購入環境を確認できません。購入は開始していません。'},409);}
  const {data,error:orderError}=await admin.rpc('prepare_boost_order_in_environment',{owner_id:user.id,listing:body.listingId,tier:body.plan,tx_environment:environment});
  if(orderError)return json({error:'公開中の自分の出品を選択してください。有効なブーストがある場合は期間終了後に購入できます。'},409);
  return json(data);
 }catch(error){
  if(error?.message==='APPLE_REFUND_REVIEW_HELD')return json({error:'Appleの返金内容を照合中です。金額を確定せず、この取引の新しい納品・受取・送金手続きを保留しています。運営へお問い合わせください。',code:'apple_refund_review_required'},409);
  if(error?.message==='APPLE_REFUND_RECONCILIATION_REQUIRED')return json({error:'Appleの返金内容を確認する必要があります。購入や返金額は確定していません。再購入せず運営へお問い合わせください。',code:'apple_refund_evidence_required'},409);
console.error('BOOST_IAP_FAILED',{name:error?.name,code:error?.code});return json({error:'購入情報を確認できません。購入済みの場合は再購入せず「購入の反映を確認」を押してください。'},503);}
});
