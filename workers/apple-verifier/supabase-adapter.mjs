// Proposed Edge-side adapter. Not connected to a deployed function.
// Apple credentials stay in Supabase; only signed data reaches the verifier.
const bundleId='com.ayuhide.koenofurima';
const products=new Set(['silver','gold','platinum'].map(x=>`${bundleId}.boost.${x}`));
const hosts={Sandbox:'https://api.storekit-sandbox.apple.com',Production:'https://api.storekit.apple.com'};
const encode=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const json64=x=>encode(new TextEncoder().encode(JSON.stringify(x)));

export function createAppleAdapter({getEnv,fetchImpl=fetch,cryptoImpl=crypto}){
 async function remote(route,body){
  const url=new URL(getEnv('APPLE_VERIFIER_URL'));
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('VERIFIER_CONFIG_INVALID');
  const secret=getEnv('APPLE_VERIFIER_SHARED_SECRET');
  if(!secret||secret.length<32)throw new Error('VERIFIER_CONFIG_MISSING');
  const response=await fetchImpl(new URL(route,url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(35000),headers:{'Content-Type':'application/json','Authorization':`Bearer ${secret}`},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('APPLE_SIGNATURE_UNVERIFIED');
  return await response.json();
 }
 function checkTransaction(tx){
  if(!tx||!hosts[tx.environment]||!/^\d+$/.test(tx.transactionId||'')||!products.has(tx.productId)||tx.type!=='Consumable'||tx.quantity!==1||tx.inAppOwnershipType!=='PURCHASED'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tx.appAccountToken||'')||!Number.isFinite(tx.purchaseDate)||tx.purchaseDate<=0||tx.revocationDate!==undefined&&(!Number.isFinite(tx.revocationDate)||tx.revocationDate<=0))throw new Error('TRANSACTION_MISMATCH');
  return tx;
 }
 async function decodeTransaction(signed){return checkTransaction((await remote('/v1/transaction',{signedTransaction:signed})).transaction);}
 async function jwt(){
  const pem=getEnv('APPLE_IAP_PRIVATE_KEY'),kid=getEnv('APPLE_IAP_KEY_ID'),iss=getEnv('APPLE_IAP_ISSUER_ID');
  if(!pem||!kid||!iss)throw new Error('APPLE_CONFIG_MISSING');
  const der=Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g,'')),x=>x.charCodeAt(0));
  const key=await cryptoImpl.subtle.importKey('pkcs8',der,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const now=Math.floor(Date.now()/1000);
  const message=json64({alg:'ES256',kid,typ:'JWT'})+'.'+json64({iss,iat:now,exp:now+180,aud:'appstoreconnect-v1',bid:bundleId});
  const signature=await cryptoImpl.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(message));
  return message+'.'+encode(signature);
 }
 async function verifiedTransaction(signed){
  const submitted=await decodeTransaction(signed);
  const response=await fetchImpl(`${hosts[submitted.environment]}/inApps/v1/transactions/${encodeURIComponent(submitted.transactionId)}`,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${await jwt()}`}});
  if(!response.ok)throw new Error('APPLE_API_UNAVAILABLE');
  const latest=await response.json();
  if(typeof latest.signedTransactionInfo!=='string')throw new Error('TRANSACTION_MISSING');
  const tx=await decodeTransaction(latest.signedTransactionInfo);
  for(const field of ['transactionId','environment','productId','appAccountToken','purchaseDate'])if(tx[field]!==submitted[field])throw new Error('TRANSACTION_MISMATCH');
  return tx;
 }
 async function verifyAndDecodeNotification(signedPayload){
  const n=(await remote('/v1/notification',{signedPayload})).notification;
  if(!n||!hosts[n.environment]||typeof n.notificationType!=='string'||n.data?.signedTransactionInfo!==undefined&&typeof n.data.signedTransactionInfo!=='string')throw new Error('NOTIFICATION_MISMATCH');
  return n;
 }
 return {verifiedTransaction,verifyAndDecodeNotification};
}
