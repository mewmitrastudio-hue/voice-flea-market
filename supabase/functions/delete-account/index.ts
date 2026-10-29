import { createClient } from "npm:@supabase/supabase-js@2.118.0";
const headers = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json; charset=utf-8"};
const respond=(body:unknown,status=200)=>Response.json(body,{status,headers});
function envKey(group:string,legacy:string){return Deno.env.get(legacy)||JSON.parse(Deno.env.get(group)||'{}').default;}
// Scan all pages within a bounded request budget; incomplete checks always block deletion.
async function stripeListHas(path:string,headers:Record<string,string>,matches:(item:any)=>boolean|Promise<boolean>){
 const deadline=Date.now()+20000;
 const seen=new Set<string>();
 let cursor='';
 for(let page=0;page<50;page++){
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new Error('Stripe list check timed out');
  const endpoint=new URL('https://api.stripe.com/v1/'+path);
  endpoint.searchParams.set('limit','100');
  if(cursor)endpoint.searchParams.set('starting_after',cursor);
  const response=await fetch(endpoint,{headers,signal:AbortSignal.timeout(Math.min(remaining,8000))});
  const list=await response.json();
  if(!response.ok||!Array.isArray(list.data)||typeof list.has_more!=='boolean')throw new Error('Invalid Stripe list response');
  for(const item of list.data){
   if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))throw new Error('Invalid Stripe list cursor');
   if(typeof item.livemode!=='boolean'||item.livemode!==/^(sk|rk)_live_/.test(headers.Authorization.slice(7)))throw new Error('Stripe mode mismatch');
   seen.add(item.id);
   if(await matches(item))return true;
  }
  if(!list.has_more)return false;
  if(!list.data.length)throw new Error('Empty Stripe continuation page');
  cursor=list.data[list.data.length-1].id;
 }
 throw new Error('Stripe list check budget exceeded');
}
Deno.serve(async(req)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return respond({message:'POSTで送信してください。'},405);
 let prepared=false;
 try{
  const auth=req.headers.get('Authorization')||'';
  if(!/^Bearer \S+$/i.test(auth))return respond({message:'ログインが必要です。'},401);
  const body=await req.json().catch(()=>null);
  if(body?.confirmation!=='DELETE_MY_ACCOUNT')return respond({message:'削除の確認が必要です。'},400);
  const url=Deno.env.get('SUPABASE_URL');
  const key=envKey('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!key)throw new Error('Missing configuration');
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  // The target is always derived from verified authentication, never request-body user_id.
  const {data:{user},error:authError}=await admin.auth.getUser(auth.slice(7));
  if(authError||!user||user.deleted_at)return respond({message:'再ログインしてください。'},401);
  const {data:profile,error:profileError}=await admin.from('profiles').select('stripe_account_id').eq('id',user.id).single();
  if(profileError)throw profileError;
  if(profile?.stripe_account_id){
   const stripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
   if(!/^(sk|rk)_(live|test)_/.test(stripeKey))return respond({message:'売上金の確認ができません。時間をおいて再試行してください。'},503);
   const stripeHeaders={Authorization:`Bearer ${stripeKey}`,'Stripe-Account':profile.stripe_account_id,'Stripe-Version':'2026-08-26.dahlia'};
   const balanceResponse=await fetch('https://api.stripe.com/v1/balance',{headers:stripeHeaders});
   const balance=await balanceResponse.json();
   if(!balanceResponse.ok||typeof balance.livemode!=='boolean'||balance.livemode!==/^(sk|rk)_live_/.test(stripeKey))return respond({message:'売上金の確認ができません。お問い合わせください。'},409);
   if(!Array.isArray(balance.available)||!Array.isArray(balance.pending))throw new Error('Invalid balance response');
   if([...balance.available,...balance.pending,...(balance.connect_reserved||[])].some(x=>Number(x.amount)!==0))return respond({message:'未受取の売上金または精算待ち残高があります。精算後に削除してください。'},409);
   if(await stripeListHas('payouts',stripeHeaders,x=>{
    if(!['pending','in_transit','paid','failed','canceled'].includes(x.status))throw new Error('Invalid payout status');
    return ['pending','in_transit'].includes(x.status);
   }))return respond({message:'振込状況の確認が必要です。振込完了後に削除してください。'},409);
  }
  // Also account for Checkout sessions created before reservation tracking was deployed.
  const legacyStripeKey=Deno.env.get('STRIPE_SECRET_KEY')||'';
  if(!/^(sk|rk)_(live|test)_/.test(legacyStripeKey))return respond({message:'決済状況を確認できません。時間をおいて再試行してください。'},503);
  if(await stripeListHas('checkout/sessions',{Authorization:`Bearer ${legacyStripeKey}`,'Stripe-Version':'2026-08-26.dahlia'},async x=>{
   if(!['open','complete','expired'].includes(x.status)||!['paid','unpaid','no_payment_required'].includes(x.payment_status))throw new Error('Invalid Checkout status');
   if(x.metadata?.buyer_id!==user.id&&x.metadata?.seller_id!==user.id)return false;
   if(x.status==='open')return true;
   if(x.status!=='complete'||x.payment_status!=='unpaid')return false;
   const piId=typeof x.payment_intent==='string'?x.payment_intent:x.payment_intent?.id;
   if(!/^pi_[A-Za-z0-9]+$/.test(piId||''))throw new Error('Checkout payment identity unavailable');
   const response=await fetch('https://api.stripe.com/v1/payment_intents/'+encodeURIComponent(piId),{headers:{Authorization:`Bearer ${legacyStripeKey}`,'Stripe-Version':'2026-08-26.dahlia'},signal:AbortSignal.timeout(8000)});
   const pi=await response.json();
   if(!response.ok||pi.id!==piId||pi.livemode!==/^(sk|rk)_live_/.test(legacyStripeKey))throw new Error('Checkout payment state unavailable');
   return pi.status!=='canceled';
  }))return respond({message:'決済手続きが進行中です。決済画面の有効期限または支払い結果をお待ちください。'},409);
  const {data:plan,error:planError}=await admin.rpc('prepare_account_deletion',{target:user.id});
  if(planError)throw planError;
  if(!plan?.allowed)return respond({message:plan?.message||'未完了の取引を確認してください。'},409);
  prepared=true;
  // Remove only this account's public samples/avatars. Transaction deliveries stay private
  // for the other party's purchased rights; no storage metadata is deleted via SQL.
  for(const bucket of ['voice-samples','profile-avatars']){
   const files: {bucket:string;name:string}[]=plan.files||[];
   if(!Array.isArray(files)||files.some(x=>!x||typeof x.bucket!=='string'||typeof x.name!=='string'))throw new Error('Invalid deletion file plan');
   const paths=files.filter(x=>x.bucket===bucket).map(x=>x.name);
   for(let i=0;i<paths.length;i+=100){
    const {error}=await admin.storage.from(bucket).remove(paths.slice(i,i+100));if(error)throw error;
   }
  }
  const {error:finishError}=await admin.rpc('finish_account_deletion',{target:user.id});
  if(finishError)throw finishError;
  const {error:signOutError}=await admin.auth.admin.signOut(auth.slice(7),'global');
  if(signOutError)throw signOutError;
  // Irreversible Auth soft deletion scrubs login identity without cascading transaction FKs.
  const {error:deleteError}=await admin.auth.admin.deleteUser(user.id,true);
  if(deleteError)throw deleteError;
  return respond({success:true});
 }catch(error){
  console.error('ACCOUNT_DELETION_FAILED',{prepared,code:error&&typeof error==='object'&&'code' in error?error.code:'internal'});
  return respond({success:false,pending:prepared,message:prepared?'削除処理の一部が未完了です。公開と利用を停止しました。お問い合わせから削除の完了をご依頼ください。':'削除できませんでした。アカウントは削除されていません。時間をおいて再試行してください。'},500);
 }
});


