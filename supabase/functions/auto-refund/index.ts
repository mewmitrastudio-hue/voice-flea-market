import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {dispatchStripeRefund,stripeRefundTransport} from '../_shared/stripe-refund-dispatch.mjs';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Content-Type':'application/json; charset=utf-8'}});
Deno.serve(async(req)=>{
 if(req.method!=='POST')return json({error:'POST required'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return json({error:'Worker authentication required'},401);
 try{
  const body=await req.json().catch(()=>null);if(body?.action!=='drain')return json({error:'Invalid action'},400);
  const url=Deno.env.get('SUPABASE_URL'),dbKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')?.trim();
  if(!url||!dbKey||!stripeKey||!/^(sk|rk)_(live|test)_/.test(stripeKey)||Deno.env.get('STRIPE_REFUND_DISPATCH_ENABLED')!=='true')return json({error:'Refund dispatch disabled or unavailable'},503);
  const db=createClient(url,dbKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:jobs,error}=await db.rpc('refund_auto_claim',{provided_token:token});if(error)return json({error:'Worker access denied'},403);
  let processed=0,review=0;
  for(const job of jobs||[]){
   let result:any;
   try{
    result=await dispatchStripeRefund({db,stripe:stripeRefundTransport(stripeKey),paymentId:job.payment_id,origin:'auto',jobId:job.id,lease:job.lease_id,
     live:/^(sk|rk)_live_/.test(stripeKey),platformId:Deno.env.get('STRIPE_DISPUTE_PLATFORM_ACCOUNT_ID')});
   }catch{return json({error:'Refund operation or outcome persistence pending'},503);}
   if(result.review_required)review++;
   const {error:saveError}=await db.rpc('refund_auto_result',{job_id:job.id,lease:job.lease_id,refund_id:result.refund_id||null,refund_status:result.status==='unknown'?null:result.status,error_code:result.error_code||null,permanent:result.review_required});
   if(saveError)return json({error:'Refund outcome persistence pending'},503);processed++;
  }
  return json({processed,review});
 }catch(error){console.error('AUTO_REFUND_FAILED',{name:error instanceof Error?error.name:'unknown'});return json({error:'Refund processing unavailable'},503);}
});
