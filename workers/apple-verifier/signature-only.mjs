import {Buffer} from 'node:buffer';
import {createHash,timingSafeEqual} from 'node:crypto';
import {rootBase64} from './trust.mjs';

const bundleId='com.ayuhide.koenofurima';
const products=new Set(['silver','gold','platinum'].map(x=>`${bundleId}.boost.${x}`));
const voiceProduct=id=>/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(id||'');
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

async function configurations(env){
 const {Environment,SignedDataVerifier}=await import('@apple/app-store-server-library');
 const appId=Number(env.APPLE_APP_ID);
 if(!Number.isSafeInteger(appId)||appId<=0)throw new Error('APP_ID_MISSING');
 return [Environment.SANDBOX,Environment.PRODUCTION].map(environment=>({environment,
  verifier:new SignedDataVerifier([Buffer.from(rootBase64,'base64')],true,environment,bundleId,environment===Environment.PRODUCTION?appId:undefined)}));
}

async function decode(configs,method,signed){
 for(const config of configs){
  try{return {data:await config.verifier[method](signed),environment:config.environment};}
  catch(error){if(error?.status!==4)throw error;}
 }
 throw new Error('ENVIRONMENT_MISMATCH');
}

export function createSignatureHandler(configure=configurations){
 return async(req,env)=>{
  if(req.method!=='POST')return reply({error:'Method not allowed'},405);
  const secret=env.APPLE_VERIFIER_SHARED_SECRET;
  if(typeof secret!=='string'||secret.length<32)return reply({error:'Unavailable'},503);
  const token=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  const digest=x=>createHash('sha256').update(x).digest();
  if(!token||token.length>256||!timingSafeEqual(digest(token),digest(secret)))return reply({error:'Unauthorized'},401);
  const route=new URL(req.url).pathname;
  if(!['/v1/transaction','/v1/notification'].includes(route))return reply({error:'Not found'},404);
  let body;
  try{
   // Enforce the limit while streaming, before JSON or cryptographic parsing.
   const reader=req.body?.getReader();if(!reader)return reply({error:'Invalid body'},400);
   const chunks=[];let size=0;
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>70000){await reader.cancel();return reply({error:'Body too large'},413);}chunks.push(Buffer.from(value));}
   body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{return reply({error:'Invalid JSON'},400);}
  const signed=route==='/v1/transaction'?body?.signedTransaction:body?.signedPayload;
  if(typeof signed!=='string'||signed.length>(route==='/v1/transaction'?30000:60000)||signed.split('.').length!==3)return reply({error:'Invalid signed data'},400);
  try{
   const configs=await configure(env);
   if(route==='/v1/transaction'){
    const {data:tx,environment}=await decode(configs,'verifyAndDecodeTransaction',signed);
    if(tx.environment!==environment||!/^\d{1,40}$/.test(tx.transactionId||'')||!(products.has(tx.productId)||voiceProduct(tx.productId))||tx.type!=='Consumable'||tx.quantity!==1||tx.inAppOwnershipType!=='PURCHASED'||!tx.appAccountToken||!Number.isFinite(tx.purchaseDate))throw new Error('TRANSACTION_MISMATCH');
    if(voiceProduct(tx.productId)&&(tx.currency!=='JPY'||!Number.isSafeInteger(tx.price)||tx.price<=0))throw new Error('TRANSACTION_PRICE_MISSING');
    return reply({transaction:{transactionId:tx.transactionId,environment,productId:tx.productId,type:tx.type,quantity:tx.quantity,inAppOwnershipType:tx.inAppOwnershipType,appAccountToken:tx.appAccountToken,purchaseDate:tx.purchaseDate,revocationDate:tx.revocationDate,price:tx.price,currency:tx.currency}});
   }
   const {data:n,environment}=await decode(configs,'verifyAndDecodeNotification',signed);
   return reply({notification:{notificationType:n.notificationType,environment,data:n.data?.signedTransactionInfo?{signedTransactionInfo:n.data.signedTransactionInfo}:undefined}});
  }catch(error){
   // Do not log signed payloads, purchase identifiers, customer data or secrets.
   console.error('APPLE_SIGNATURE_VERIFICATION_FAILED',{name:error?.name,status:error?.status});
   return reply({error:'Apple verification unavailable'},503);
  }
 };
}

// This service has no Apple signing private key or database credentials.
// Authoritative App Store API lookup and database reconciliation stay upstream.
export default {fetch:createSignatureHandler()};
