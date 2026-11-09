import { createClient } from "npm:@supabase/supabase-js@2.118.0";
const headers={"Content-Type":"application/json; charset=utf-8"};
Deno.serve(async(req)=>{
 if(req.method!=='POST')return Response.json({error:'POST required'},{status:405,headers});
 try{
  const token=req.headers.get('x-notification-token');
  if(!token)return Response.json({error:'Unauthorized'},{status:401,headers});
  const body=await req.json();const kind=body?.kind;const id=body?.record?.id;
  if(!['report','support'].includes(kind)||!id)return Response.json({error:'Invalid request'},{status:400,headers});
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default;
  const url=Deno.env.get('SUPABASE_URL');const resend=Deno.env.get('RESEND_API_KEY');const to=Deno.env.get('SUPPORT_NOTIFY_TO');
  if(!key||!url||!resend||!to)throw new Error('Configuration missing');
  const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await admin.rpc('notification_payload',{item_id:id,kind,provided_token:token});
  if(error)return Response.json({error:'Invalid notification'},{status:403,headers});
  if(data?.already_sent)return Response.json({ok:true,already_sent:true},{headers});
  const record=data.record;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resend}`,'Content-Type':'application/json','Idempotency-Key':data.key},body:JSON.stringify({from:'声のフリマ <support@koe-furima.com>',to:[to],subject:kind==='report'?'【声のフリマ】新しい通報':'【声のフリマ】新しいお問い合わせ',text:`受付ID: ${id}\n種別: ${kind}\n返信先: ${record.reply_email||'アプリ内の登録情報をご確認ください'}\n内容:\n${record.reason||record.subject||''}\n${record.details||record.message||''}\n\n運営アカウントの「通報・お問い合わせ対応」で確認してください。`})});
  if(!response.ok)throw new Error('Notification delivery failed');
  const {error:saveError}=await admin.rpc('record_notification_sent',{event_key:data.key});if(saveError)throw saveError;
  return Response.json({ok:true},{headers});
 }catch(error){console.error('NOTIFICATION_FAILED',{code:error?.code||'internal'});return Response.json({error:'Notification unavailable'},{status:500,headers});}
});
