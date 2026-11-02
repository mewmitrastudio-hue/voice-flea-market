import {createClient} from 'npm:@supabase/supabase-js@2.118.0';
import {appleFinancialReportSnapshot} from '../_shared/apple-financial-report.mjs';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers});
 if(req.method!=='POST')return json({error:'POSTで送信してください。'},405);
 const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
 if(!token)return json({error:'ログインしてください。'},401);
 try{
  const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default,admin=Deno.env.get('ADMIN_USER_ID')?.trim();
  if(!url||!key||!admin)return json({error:'運営用の設定を確認できません。'},503);
  const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:{user},error}=await db.auth.getUser(token);
  if(error||!user)return json({error:'再ログインしてください。'},401);
  if(user.id!==admin)return json({error:'運営アカウント専用です。'},403);
  // Bound the body before JSON.parse; never log or echo report contents on errors.
  const reader=req.body?.getReader();if(!reader)return json({error:'レポートを選んでください。'},400);
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>2200000){await reader.cancel();return json({error:'ファイルが大きすぎます。'},413);}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  let body:any,snapshot:any;
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));snapshot=await appleFinancialReportSnapshot(body.text,body.name);}
  catch{return json({error:'財務レポートの形式・数量・金額を確認できません。元のタブ区切りテキストを選んでください。'},422);}
  if(body.action==='preview')return json({success:true,snapshot});
  if(body.action!=='import'||body.sha256!==snapshot.sha256)return json({error:'ファイルが変わりました。内容を再確認してください。'},409);
  const result=await db.rpc('store_apple_financial_report',{actor:user.id,snapshot,source_text:body.text});
  if(result.error)return json({error:'レポートを保存できませんでした。確認して再試行してください。'},503);
  return json({success:true,report:result.data});
 }catch{return json({error:'財務レポートを処理できませんでした。時間をおいて再確認してください。'},503);}
});
