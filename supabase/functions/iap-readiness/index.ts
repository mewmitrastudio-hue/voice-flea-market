import {diagnoseSelf} from './diagnostic.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'GET, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers});
const uuid=(id:unknown)=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
// Every upstream request is a bounded GET. No purchase or account mutation imports.
async function read(url:string,headers:Record<string,string>){
 const response=await fetch(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error('READ_FAILED');
 return response.json();
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='GET')return json({error:'読取専用です。'},405);
 // No owner, seller, product or alternate destination can be selected by a caller.
 if(new URL(req.url).search)return json({error:'診断対象はログイン本人のみです。'},400);
 const authorization=req.headers.get('Authorization')||'';
 if(!/^Bearer \S+$/i.test(authorization))return json({error:'ログインしてください。'},401);
 try{
  const getEnv=(name:string)=>Deno.env.get(name);
  const base=getEnv('SUPABASE_URL')||'';
  const parsed=new URL(base);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('CONFIG');
  const key=getEnv('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(getEnv('SUPABASE_SECRET_KEYS')||'{}').default;
  if(typeof key!=='string'||!key)throw Error('CONFIG');
  let user;
  try{user=await read(`${base}/auth/v1/user`,{apikey:key,Authorization:authorization});}
  catch{return json({error:'本人認証を確認できません。'},401);}
  if(!uuid(user?.id)||user.is_anonymous===true)return json({error:'本人認証を確認できません。'},401);
  const adminHeaders={apikey:key,Authorization:`Bearer ${key}`};
  const result=await diagnoseSelf({
   authenticate:async()=>user,getEnv,
   readOwnRecipient:async(id:string)=>{
    if(id!==user.id)throw Error('OWNER');
    const rows=await read(`${base}/rest/v1/profiles?select=id,stripe_account_id&id=eq.${encodeURIComponent(id)}`,adminHeaders);
    if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==user.id)throw Error('PROFILE');
    return rows[0];
   },
   readStripeRecipient:async(id:string)=>{
    if(!/^acct_[A-Za-z0-9]+$/.test(id))throw Error('ACCOUNT');
    const url=new URL(`https://api.stripe.com/v2/core/accounts/${encodeURIComponent(id)}`);
    url.searchParams.append('include[0]','configuration.recipient');url.searchParams.append('include[1]','requirements');
    return read(url.toString(),{Authorization:`Bearer ${getEnv('STRIPE_SECRET_KEY')||''}`,'Stripe-Version':'2026-09-30.endive'});
   },
   readCatalogue:async()=>read(`${base}/rest/v1/rpc/read_voice_iap_diagnostic_products`,adminHeaders)
  });
  return json(result);
 }catch{return json({error:'設定診断は未確認です。配備状況を確認してください。'},503);}
});
