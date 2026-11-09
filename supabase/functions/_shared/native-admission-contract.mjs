const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,allowed)=>record(x)&&Object.keys(x).every(k=>allowed.includes(k));
const timestamp=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(x)&&Number.isFinite(Date.parse(x));
export const validCursor=x=>exact(x,['createdAt','orderId'])&&timestamp(x.createdAt)&&uuid(x.orderId);
export function validRequest(b){
 if(!record(b)||b.version!==3)return false;
 if(b.action==='listAttempts')return exact(b,['version','action','pageSize','cursor'])&&(!('pageSize'in b)||Number.isInteger(b.pageSize)&&b.pageSize>=1&&b.pageSize<=100)&&(!('cursor'in b)||validCursor(b.cursor));
 if(b.action==='prepareInitial')return exact(b,['version','action','kind','subjectId','freshOrderId','boostPlan','storeKitEnvironment'])&&['voice_listing','voice_job','boost'].includes(b.kind)&&uuid(b.subjectId)&&uuid(b.freshOrderId)&&(b.kind==='boost'?['silver','gold','platinum'].includes(b.boostPlan):!('boostPlan'in b))&&(!('storeKitEnvironment'in b)||['Sandbox','Production'].includes(b.storeKitEnvironment));
 if(!['status','begin','cancelReport','pendingReport','prepareRetry'].includes(b.action))return false;
 return exact(b,['version','action','orderId','attemptNonce',...(b.action==='prepareRetry'?['freshOrderId']:[])])&&uuid(b.orderId)&&uuid(b.attemptNonce)&&(b.action!=='prepareRetry'||uuid(b.freshOrderId)&&b.freshOrderId!==b.orderId);
}
const fields=['orderId','intentId','attemptNonce','previousOrderId','environment','productId','amountJpy','state'];
function attempt(a){
 return exact(a,fields)&&fields.every(k=>k in a)&&uuid(a.orderId)&&uuid(a.intentId)&&uuid(a.attemptNonce)&&(a.previousOrderId===null||uuid(a.previousOrderId))&&['Sandbox','Production'].includes(a.environment)&&typeof a.productId==='string'&&/^com\.ayuhide\.koenofurima\.(voice\.jpy[1-9][0-9]{0,7}|boost\.(silver|gold|platinum))$/.test(a.productId)&&Number.isInteger(a.amountJpy)&&a.amountJpy>0&&['prepared','dispatch_unknown','pending_approval','client_reported_cancelled','transaction_observed','retired'].includes(a.state);
}
export function canonicalResponse(data,request,ownerId){
 if(!record(data)||typeof data.launchGranted!=='boolean')return null;
 const base={version:3,backendProjectRef:'tyulybijubckitybgubc',ownerId};
 if(request.action==='listAttempts'){
  if(!exact(data,['attempts','nextCursor','launchGranted'])||data.launchGranted!==false||!Array.isArray(data.attempts)||data.attempts.length>(request.pageSize??25)||!data.attempts.every(attempt)||!('nextCursor'in data)||!(data.nextCursor===null||validCursor(data.nextCursor))||new Set(data.attempts.map(a=>a.orderId)).size!==data.attempts.length)return null;
  return {...base,attempts:data.attempts,nextCursor:data.nextCursor,launchGranted:false};
 }
 if(!exact(data,['attempt','launchGranted'])||!attempt(data.attempt))return null;
 const a=data.attempt;
 if(a.orderId!==(request.action==='prepareInitial'||request.action==='prepareRetry'?request.freshOrderId:request.orderId))return null;
 if(!['prepareInitial','prepareRetry'].includes(request.action)&&a.attemptNonce!==request.attemptNonce)return null;
 if(request.action==='prepareRetry'&&a.previousOrderId!==request.orderId)return null;
 if(request.action==='prepareInitial'&&a.previousOrderId!==null)return null;
 if(data.launchGranted&&(request.action!=='begin'||a.state!=='dispatch_unknown'))return null;
 return {...base,action:request.action,attempt:a,launchGranted:data.launchGranted};
}
