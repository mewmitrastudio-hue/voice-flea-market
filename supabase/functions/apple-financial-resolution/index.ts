import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import Stripe from 'npm:stripe@23.0.0';
import {adjustmentPreview,bankReceiptPreview} from '../_shared/apple-financial-resolution.mjs';
import {collectApplePayoutEvidence} from '../_shared/apple-payout-collector.mjs';
import {appleConfig,applyTransaction} from '../_shared/apple.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store'};
const reply=(x:unknown,status=200)=>Response.json(x,{status,headers});
const uuid=(x:unknown)=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});if(req.method!=='POST')return reply({error:'POST required'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];if(!token)return reply({error:'ログインしてください。'},401);
 try{
  const reader=req.body?.getReader();if(!reader)return reply({error:'入力を確認してください。'},400);let length=0;const chunks=[];
  for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>12000){await reader.cancel();return reply({error:'入力が大きすぎます。'},413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const b=JSON.parse(new TextDecoder().decode(bytes));
  if(!uuid(b.operationId)||!['previewAdjustment','previewBankReceipt','approve','status'].includes(b.action))return reply({error:'操作番号と入力を確認してください。'},400);
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default,owner=Deno.env.get('ADMIN_USER_ID');
  if(!url||!key||!owner)return reply({error:'運営設定が未確認です。'},503);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error}=await db.auth.getUser(token);if(error||!user)return reply({error:'再ログインしてください。'},401);if(user.id!==owner)return reply({error:'運営専用です。'},403);
  const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error('resolution_database_not_confirmed');return r.data;};
  const read=()=>rpc('get_apple_financial_review',{actor:user.id,operation:b.operationId});
  const response=(r:any)=>{const complete=r.kind==='bank'&&r.state==='approved'&&r.terminal?.state==='settled'&&r.terminal?.review_id===r.id;return {operationId:r.id,kind:r.kind,state:r.state,previewHash:r.preview_hash,summary:{...r.summary,...r.kind==='bank'&&r.state==='approved'?{operatorBankReceiptApproved:true}:{}},settlementComplete:complete,reviewRequired:!complete};};
  let existing=await read();
  if(b.action==='status')return existing?reply(response(existing)):reply({operationId:b.operationId,code:'operation_not_found',error:'この操作の保存記録はありません。同じ操作番号・入力で確認し直してください。'},404);
  if(b.action==='approve'&&existing?.state==='approved')return reply(response(existing));
  if(b.action==='approve'&&(!existing||existing.state!=='preview'||b.confirmation!==true||b.previewHash!==existing.preview_hash))return reply({error:'保存済み確認内容と承認条件が一致しません。'},409);
  if(existing&&b.action!=='approve'&&existing.state!=='preview')return reply(response(existing));
  const input=b.action==='approve'?existing.input:Object.fromEntries(Object.entries(b).filter(([k])=>!['action','operationId'].includes(k)));
  if(!uuid(input.paymentId))return reply({error:'決済IDを確認してください。'},400);
  const kind=b.action==='approve'?existing.kind:b.action==='previewAdjustment'?'adjustment':'bank';
  const context=await rpc('apple_financial_resolution_context',{actor:user.id,purchase:input.paymentId,report:kind==='adjustment'?input.reportId:null});
  let summary,observation=null;
  if(kind==='adjustment')summary=adjustmentPreview(context,input);
  else{
   const p=context.payment,platform=Deno.env.get('APPLE_SETTLEMENT_STRIPE_ACCOUNT_ID'),secret=Deno.env.get('STRIPE_SECRET_KEY')||'';
   if(!/^rk_live_|^sk_live_/.test(secret)||!platform||context.operation?.platform_id!==platform)throw Error('production_read_configuration_required');
   const tx=await appleConfig().verifier.verifiedTransactionById(p.apple_transaction_id,'Production');
   if(tx.environment!=='Production'||tx.transactionId!==p.apple_transaction_id||tx.productId!=='com.ayuhide.koenofurima.voice.jpy'+p.amount_jpy||tx.currency!=='JPY'||tx.price!==p.amount_jpy*1000)throw Error('current_apple_evidence_mismatch');
   if(tx.revocationDate!==undefined||tx.revocationType!==undefined||tx.revocationPercentage!==undefined){await applyTransaction(db,tx,p.buyer_id);throw Error('refund_requires_review');}
   const stripe=new Stripe(secret,{apiVersion:'2026-09-30.endive',maxNetworkRetries:0,timeout:20000});
   const collected=await collectApplePayoutEvidence({stripe,operation:context.operation,payoutId:input.payoutId,bankAccountId:input.bankAccountId,maxAgeMs:60000});
   summary=bankReceiptPreview(context,input,collected.verification);observation=collected.evidence;
  }
  const canonical=(x:any)=>JSON.stringify(Object.keys(x).sort().map(k=>[k,x[k]]));
  if(existing&&canonical(summary)!==canonical(existing.summary)){await rpc('invalidate_apple_financial_preview',{actor:user.id,operation:b.operationId});return reply(response(await read()));}
  if(b.action==='approve'){
   await rpc('approve_apple_financial_review',{actor:user.id,operation:b.operationId,preview_hash:b.previewHash,fresh_summary:summary,observation});return reply(response(await read()));
  }
  await rpc('store_apple_financial_review',{actor:user.id,operation:b.operationId,kind,purchase:input.paymentId,input,summary,observation});return reply(response(await read()));
 }catch(error){
  if(error instanceof SyntaxError)return reply({error:'入力形式を確認してください。'},400);
  // Never log statement references, notes, signed receipts, account details or credentials.
  console.warn('FINANCIAL_RESOLUTION_NOT_CONFIRMED');
  return reply({error:'照合・保存結果は未確認です。同じ操作番号で状態を確認してください。金額が不明なまま承認や送金は行いません。',code:'resolution_not_confirmed'},409);
 }
});
