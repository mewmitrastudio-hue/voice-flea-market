import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {dispatchAppleSettlement,reconcileAppleSettlement,recoverAppleSettlement,reconcileAppleRecovery} from '../_shared/apple-settlement.mjs';
import {requireRecipient} from '../_shared/recipient-readiness.mjs';
import {appleConfig,applyTransaction} from '../_shared/apple.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers});
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return reply({error:'POST required'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return reply({error:'Sign in required'},401);
 try{
  const reader=req.body?.getReader();if(!reader)return reply({error:'Request required'},400);
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048){await reader.cancel();return reply({error:'Request too large'},413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder().decode(bytes));
  if(!['prepare','dispatch','reconcile','recover','reconcileRecovery'].includes(body.action)||typeof body.paymentId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.paymentId))return reply({error:'Invalid request'},400);
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const platformId=Deno.env.get('APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID');
  if(!url||!key||!/^acct_[A-Za-z0-9]+$/.test(platformId||''))return reply({error:'Settlement configuration required'},503);
  const opts={auth:{persistSession:false,autoRefreshToken:false}};
  const admin=createClient(url,key,opts);
  const {data:{user},error:authError}=await admin.auth.getUser(token);
  if(authError||!user)return reply({error:'Sign in required'},401);
  const operator=createClient(url,key,{...opts,global:{headers:{Authorization:`Bearer ${token}`}}});
  // Database authority checks moderator status; neither role nor financial
  // destination/amount is accepted from browser input.
  const {data:op,error}=await operator.rpc('prepare_apple_settlement',{purchase:body.paymentId,platform:platformId});
  if(error||!op)return reply({error:'Eligible allocation and operator access required'},403);
  if(body.action==='prepare')return reply({operation:op,bankPayout:'unverified'});
  const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!/^(sk|rk)_live_/.test(stripeKey))return reply({error:'Production Stripe configuration required'},503);
  const stripe=new Stripe(stripeKey,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
  const rpc=async(name:string,args:Record<string,unknown>)=>{const {data,error}=await admin.rpc(name,args);if(error)throw Error('settlement_persistence_pending');return data;};
  const journal={claimRecovery:async(id:string)=>rpc('claim_apple_recovery',{operation:id}),recordRecovery:async(id:string,evidence:unknown)=>rpc('record_apple_recovery',{operation:id,evidence}),load:async()=>op,claim:async(id:string)=>rpc('claim_apple_settlement',{operation:id}),record:async(id:string,transfer:unknown)=>rpc('record_apple_settlement',{operation:id,evidence:transfer})};
  if(body.action==='reconcile'){
   if((await stripe.accounts.retrieve()).id!==platformId)throw Error('settlement_platform_mismatch');
   const result=await reconcileAppleSettlement({op,transferId:body.transferId||op.transfer_id,stripe,journal});
   return reply(result);
  }
  if(body.action==='recover'||body.action==='reconcileRecovery'){
   if((await stripe.accounts.retrieve()).id!==platformId)throw Error('settlement_platform_mismatch');
   if(body.action==='reconcileRecovery')return reply(await reconcileAppleRecovery({op,stripe,journal,reversalId:body.reversalId}));
   return reply(await recoverAppleSettlement({op,stripe,journal,platformId,
    enabled:Deno.env.get('APPLE_SETTLEMENT_TRANSFERS_ENABLED')==='true',
    verifyRefund:async(paymentId:string)=>{
     const {data:p,error}=await admin.from('payments').select('id,buyer_id,apple_transaction_id,apple_environment,amount_jpy').eq('id',paymentId).single();
     if(error||!p||p.apple_environment!=='Production')throw Error('settlement_apple_payment_mismatch');
     const tx=await appleConfig().verifier.verifiedTransactionById(p.apple_transaction_id,'Production');
     if(tx.productId!=='com.ayuhide.koenofurima.voice.jpy'+p.amount_jpy||tx.price!==p.amount_jpy*1000||tx.currency!=='JPY')throw Error('settlement_apple_payment_mismatch');
     const applied=await applyTransaction(admin,tx,p.buyer_id);
     if(applied.paymentId!==p.id||!applied.revoked)throw Error('settlement_verified_refund_required');
    }}));
  }
  const result=await dispatchAppleSettlement({journal,stripe,platformId,
   enabled:Deno.env.get('APPLE_SETTLEMENT_TRANSFERS_ENABLED')==='true'&&Deno.env.get('APPLE_SETTLEMENT_FUNDING_APPROVED')==='true',
   recipient:async(sellerId:string)=>requireRecipient({admin,sellerId,stripe,live:true}),
   verifyApple:async(paymentId:string)=>{
    const {data:p,error}=await admin.from('payments').select('id,buyer_id,apple_transaction_id,apple_environment,amount_jpy').eq('id',paymentId).single();
    if(error||!p||p.apple_environment!=='Production')throw Error('settlement_apple_payment_mismatch');
    const tx=await appleConfig().verifier.verifiedTransactionById(p.apple_transaction_id,'Production');
    if(tx.productId!=='com.ayuhide.koenofurima.voice.jpy'+p.amount_jpy||tx.price!==p.amount_jpy*1000||tx.currency!=='JPY')throw Error('settlement_apple_payment_mismatch');
    const applied=await applyTransaction(admin,tx,p.buyer_id);
    if(applied.paymentId!==p.id||applied.revoked)throw Error('settlement_apple_payment_revoked');
   }});
  return reply(result);
 }catch(error){
  if(error?.message==='APPLE_REFUND_REVIEW_HELD')return reply({error:'Appleの返金内容を照合中です。金額を確定せず、この取引の新しい納品・受取・送金手続きを保留しています。運営へお問い合わせください。',code:'apple_refund_review_required'},409);
  if(error?.message==='APPLE_REFUND_RECONCILIATION_REQUIRED')return reply({error:'Appleの返金内容を確認する必要があります。購入や返金額は確定していません。再購入せず運営へお問い合わせください。',code:'apple_refund_evidence_required'},409);

  if(error instanceof SyntaxError)return reply({error:'Invalid request'},400);
  // Do not expose Stripe bodies, financial reports or keys in logs/responses.
  console.warn('APPLE_SETTLEMENT_NOT_CONFIRMED');
  return reply({error:'精算結果は未確認です。送金を繰り返さず、既存の送金記録を照合してください。'},409);
 }
});
