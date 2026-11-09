import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {appleConfig} from '../_shared/apple.ts';
import {requireRecipient} from '../_shared/recipient-readiness.mjs';
import {preparationEnvironment,recipientEnvironment,purchaseEnvironments} from '../_shared/iap-environment.mjs';
import {validRequest,canonicalResponse} from '../_shared/native-admission-contract.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const fail=(code:string,status:number)=>json({code},status);
const project='tyulybijubckitybgubc';
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return fail('invalid_request',405);
 try{
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!token)return fail('authentication_required',401);
  const reader=req.body?.getReader();if(!reader)return fail('invalid_request',400);
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8192){await reader.cancel();return fail('invalid_request',400);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail('invalid_request',400);}
  if(!validRequest(body))return fail('invalid_request',400);
  for(const k of ['orderId','attemptNonce','freshOrderId','subjectId'])if(typeof body[k]==='string')body[k]=body[k].toLowerCase();
  if(body.cursor)body.cursor.orderId=body.cursor.orderId.toLowerCase();
  if(Deno.env.get('SUPABASE_URL')!==`https://${project}.supabase.co`)return fail('database_not_confirmed',503);
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  if(!key)return fail('database_not_confirmed',503);
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return fail('authentication_required',401);
  const newAdmission=['prepareInitial','begin','prepareRetry'].includes(body.action);
  if(newAdmission&&Deno.env.get('NATIVE_PURCHASE_RECOVERY_V3_ENABLED')!=='true')return fail('recovery_not_enabled',503);
  let environment=null,seller=null;
  if(newAdmission){
   let kind=body.kind;
   if(body.action!=='prepareInitial'){
    const {data,error}=await admin.rpc('native_purchase_context',{actor:user.id,requested_order:body.orderId,requested_nonce:body.attemptNonce});
    if(error)return fail(error.message==='not_authorized'?'not_authorized':'database_not_confirmed',error.message==='not_authorized'?403:503);
    if(!data||!['voice_listing','voice_job','boost'].includes(data.kind))return fail('database_not_confirmed',503);
    kind=data.kind;environment=data.environment;seller=data.sellerId;
   }
   const prefix=kind==='boost'?'BOOST':'VOICE';
   if(Deno.env.get(`${prefix}_IAP_ENABLED`)!=='true')return fail('recovery_not_enabled',503);
   appleConfig();
   try{environment=preparationEnvironment(Deno.env.get(`${prefix}_IAP_ENVIRONMENT`),body.action==='prepareInitial'?body.storeKitEnvironment:environment);}catch{return fail('purchase_state_conflict',409);}
   if(kind!=='boost'){
    if(body.action==='prepareInitial'){
     if(kind==='voice_job'){
      const {data:a,error:e}=await admin.from('applications').select('id,job_id,applicant_id,status').eq('id',body.subjectId).maybeSingle();
      if(e||!a||a.status!=='accepted')return fail('purchase_state_conflict',409);
      const {data:j,error:je}=await admin.from('jobs').select('id,buyer_id,status').eq('id',a.job_id).maybeSingle();
      if(je||!j||j.buyer_id!==user.id||j.status!=='open')return fail('purchase_state_conflict',409);seller=a.applicant_id;
     }else{
      const {data:l,error:e}=await admin.from('listings').select('id,seller_id,is_active').eq('id',body.subjectId).maybeSingle();
      if(e||!l?.is_active)return fail('purchase_state_conflict',409);seller=l.seller_id;
     }
    }
    if(typeof seller!=='string'||seller===user.id)return fail('purchase_state_conflict',409);
    const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
    try{
     const mode=recipientEnvironment(Deno.env.get('VOICE_IAP_ENVIRONMENT'),environment,stripeKey);
     await requireRecipient({admin,sellerId:seller,stripe:new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000}),live:mode==='Production'});
    }catch{return fail('purchase_state_conflict',409);}
   }
  }
  const listing=body.action==='listAttempts';
  const args=listing?{actor:user.id,page_size:body.pageSize??25,after_created:body.cursor?.createdAt??null,after_order:body.cursor?.orderId??null}:{actor:user.id,requested_action:body.action,requested_order:body.orderId??null,requested_nonce:body.attemptNonce??null,fresh_order:body.freshOrderId??null,requested_kind:body.kind??null,subject:body.subjectId??null,tier:body.boostPlan??null,tx_environment:environment,expected_seller:seller,voice_environments:purchaseEnvironments(Deno.env.get('VOICE_IAP_ENVIRONMENT')),boost_environments:purchaseEnvironments(Deno.env.get('BOOST_IAP_ENVIRONMENT'))};
  const {data,error}=await admin.rpc(listing?'native_purchase_list_attempts':'native_purchase_admission',args);
  if(error){
   const code=error.message;
   if(code==='not_authorized')return fail(code,403);
   if(['purchase_state_conflict','quote_changed','legacy_reconciliation_required','review_required','already_fulfilled'].includes(code))return fail(code,409);
   if(code==='recovery_not_enabled')return fail(code,503);
   return fail('database_not_confirmed',503);
  }
  const result=canonicalResponse(data,body,user.id);
  return result?json(result):fail('outcome_unknown',503);
 }catch{return fail('outcome_unknown',503);}
});
