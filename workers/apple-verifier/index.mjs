import {Buffer} from 'node:buffer';
import {createHash, timingSafeEqual} from 'node:crypto';

const bundleId = 'com.ayuhide.koenofurima';
const products = new Set(['silver','gold','platinum'].map(tier=>`${bundleId}.boost.${tier}`));
const rootBase64 = 'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';
const reply = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

async function configurations(env) {
 // Some SDK dependencies initialize randomness. Workers permits that only
 // inside a request, so initialize the official SDK lazily in the handler.
 const {AppStoreServerAPIClient, Environment, SignedDataVerifier}=await import('@apple/app-store-server-library');
 const appId=Number(env.APPLE_APP_ID);
 if (!env.APPLE_IAP_PRIVATE_KEY || !env.APPLE_IAP_KEY_ID || !env.APPLE_IAP_ISSUER_ID || !Number.isSafeInteger(appId) || appId<=0) throw new Error('APPLE_CONFIG_MISSING');
 return [Environment.SANDBOX,Environment.PRODUCTION].map(environment=>({
  environment,
  verifier:new SignedDataVerifier([Buffer.from(rootBase64,'base64')],true,environment,bundleId,environment===Environment.PRODUCTION?appId:undefined),
  client:new AppStoreServerAPIClient(env.APPLE_IAP_PRIVATE_KEY,env.APPLE_IAP_KEY_ID,env.APPLE_IAP_ISSUER_ID,bundleId,environment),
 }));
}

async function decodeInVerifiedEnvironment(configs,method,signed) {
 // No unsigned payload fields choose an environment. Each candidate performs
 // Apple's complete signature, chain, expiry, Apple OID and online OCSP checks.
 for (const config of configs) {
  try {return {config,data:await config.verifier[method](signed)};}
  catch(error) {if(error?.status!==4) throw error;}
 }
 throw new Error('APPLE_ENVIRONMENT_MISMATCH');
}

export async function verifyTransaction(configs,signed) {
 const {config,data:submitted}=await decodeInVerifiedEnvironment(configs,'verifyAndDecodeTransaction',signed);
 if (!submitted.transactionId) throw new Error('TRANSACTION_MISSING');
 const latest=await config.client.getTransactionInfo(submitted.transactionId);
 if (!latest.signedTransactionInfo) throw new Error('TRANSACTION_MISSING');
 const tx=await config.verifier.verifyAndDecodeTransaction(latest.signedTransactionInfo);
 if (tx.transactionId!==submitted.transactionId || tx.environment!==config.environment || !products.has(tx.productId) || tx.type!=='Consumable' || tx.quantity!==1 || tx.inAppOwnershipType!=='PURCHASED' || !tx.appAccountToken || !Number.isFinite(tx.purchaseDate)) throw new Error('TRANSACTION_MISMATCH');
 // Only data needed by the existing idempotent database function leaves here.
 return {transactionId:tx.transactionId,environment:tx.environment,productId:tx.productId,appAccountToken:tx.appAccountToken,purchaseDate:tx.purchaseDate,revocationDate:tx.revocationDate};
}

export function createHandler(configure=configurations) {
 return async function handle(req,env) {
  if(req.method!=='POST') return reply({error:'Method not allowed'},405);
  const configured=env.APPLE_VERIFIER_SHARED_SECRET;
  if(typeof configured!=='string'||configured.length<32) return reply({error:'Service unavailable'},503);
  const presented=(req.headers.get('Authorization')||'').match(/^Bearer (\S+)$/i)?.[1];
  if(!presented || presented.length>256 || !timingSafeEqual(createHash('sha256').update(presented).digest(),createHash('sha256').update(configured).digest())) return reply({error:'Unauthorized'},401);
  const route=new URL(req.url).pathname;
  if(!['/v1/transaction','/v1/notification'].includes(route)) return reply({error:'Not found'},404);
  let raw;
  try {raw=await req.text();}catch{return reply({error:'Invalid body'},400);}
  if(Buffer.byteLength(raw)>70000) return reply({error:'Body too large'},413);
  let body;
  try{body=JSON.parse(raw);}catch{return reply({error:'Invalid JSON'},400);}
  const signed=route==='/v1/transaction'?body?.signedTransaction:body?.signedPayload;
  if(typeof signed!=='string'||signed.length>(route==='/v1/transaction'?30000:60000)||signed.split('.').length!==3) return reply({error:'Invalid signed data'},400);
  try {
   const configs=await configure(env);
   if(route==='/v1/transaction') return reply({transaction:await verifyTransaction(configs,signed)});
   const {config,data:notification}=await decodeInVerifiedEnvironment(configs,'verifyAndDecodeNotification',signed);
   if(notification.notificationType==='TEST') return reply({notificationType:'TEST'});
   const txSigned=notification.data?.signedTransactionInfo;
   if(!txSigned) return reply({notificationType:notification.notificationType});
   const transaction=await verifyTransaction([config],txSigned);
   return reply({notificationType:notification.notificationType,transaction});
  }catch(error){
   console.error('APPLE_VERIFICATION_FAILED',{name:error?.name,status:error?.status,code:error?.code});
   return reply({error:'Apple verification unavailable'},503);
  }
 };
}

export default {fetch:createHandler()};
