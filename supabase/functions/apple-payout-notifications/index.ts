import Stripe from 'npm:stripe@23.0.0';
import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {reconcileApplePayoutFailure} from '../_shared/apple-payout-events.mjs';
Deno.serve(async req=>{
 if(req.method!=='POST')return new Response('POST required',{status:405});
 const secret=Deno.env.get('APPLE_PAYOUT_WEBHOOK_SECRET'),key=Deno.env.get('STRIPE_SECRET_KEY')||'',url=Deno.env.get('SUPABASE_URL'),dbkey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
 if(!secret||!/^rk_live_|^sk_live_/.test(key)||!url||!dbkey)return new Response('Unavailable',{status:503});
 try{
  const reader=req.body?.getReader();if(!reader)return new Response('Invalid body',{status:400});let length=0;const chunks=[];
  for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>200000){await reader.cancel();return new Response('Too large',{status:413});}chunks.push(value);}
  const bytes=new Uint8Array(length);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  const stripe=new Stripe(key,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
  const event=await stripe.webhooks.constructEventAsync(new TextDecoder().decode(bytes),req.headers.get('stripe-signature')||'',secret);
  const db=createClient(url,dbkey,{auth:{persistSession:false,autoRefreshToken:false}});
  await reconcileApplePayoutFailure({event,stripe,db});return Response.json({received:true});
 }catch{console.warn('APPLE_PAYOUT_EVENT_NOT_CONFIRMED');return Response.json({error:'Could not reconcile'},{status:503});}
});
