import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {appleConfig,verifiedTransaction,applyTransaction} from '../_shared/apple.ts';
Deno.serve(async(req)=>{
 if(req.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
 let stage='configuration';
 try{
  const body=await req.json();
  if(typeof body.signedPayload!=='string'||body.signedPayload.length>60000)return Response.json({error:'Invalid notification'},{status:400});
  const {verifier}=appleConfig();
  stage='signature';
  const notification=await verifier.verifyAndDecodeNotification(body.signedPayload);
  if(notification.notificationType==='TEST')return Response.json({received:true});
  const signed=notification.data?.signedTransactionInfo;
  if(!signed)return Response.json({received:true});
  stage='transaction';
  const tx=await verifiedTransaction(signed);
  const url=Deno.env.get('SUPABASE_URL')||'';
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const admin=createClient(url,key,{auth:{persistSession:false}});
  stage='database';
  await applyTransaction(admin,tx);
  return Response.json({received:true});
 }catch(error){console.error('APPLE_BOOST_NOTIFICATION_FAILED',{stage,name:error?.name,status:error?.status,code:error?.code,unsupported:error?.cause?.message?.startsWith('Not implemented: crypto.')?error.cause.message:undefined,reason:error?.message==='APPLE_CONFIG_MISSING'?'APPLE_CONFIG_MISSING':undefined});return Response.json({error:'Notification could not be reconciled'},{status:503});}
});
