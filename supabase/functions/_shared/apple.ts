import {createAppleAdapter} from './apple-adapter.mjs';
export const bundleId='com.ayuhide.koenofurima';
export const products=['silver','gold','platinum'].map(p=>`${bundleId}.boost.${p}`);
export function enabled(){return Deno.env.get('BOOST_IAP_ENABLED')==='true';}
export function appleConfig(){
 const getEnv=(name:string)=>Deno.env.get(name);
 for(const name of ['APPLE_IAP_PRIVATE_KEY','APPLE_IAP_ISSUER_ID','APPLE_IAP_KEY_ID','APPLE_VERIFIER_URL','APPLE_VERIFIER_SHARED_SECRET']){
  if(!getEnv(name))throw new Error('APPLE_CONFIG_MISSING');
 }
 const url=new URL(getEnv('APPLE_VERIFIER_URL')!);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||getEnv('APPLE_VERIFIER_SHARED_SECRET')!.length<32)throw new Error('APPLE_CONFIG_MISSING');
 const adapter=createAppleAdapter({getEnv});
 return {verifier:adapter,environment:getEnv('BOOST_IAP_ENVIRONMENT')==='Production'?'Production':'Sandbox'};
}
export async function verifiedTransaction(signed:string){return appleConfig().verifier.verifiedTransaction(signed);}
export async function applyTransaction(admin:any,tx:any,actor:string|null=null){
 const voice=/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(tx.productId||'');
 const args:any={order_id:tx.appAccountToken,tx_id:tx.transactionId,sku:tx.productId,tx_environment:tx.environment,purchased_at:new Date(tx.purchaseDate).toISOString(),revoked:Boolean(tx.revocationDate)};
 if(voice)Object.assign(args,{price_milliunits:tx.price,currency:tx.currency,actor});
 const {data,error}=await admin.rpc(voice?'apply_verified_apple_voice':'apply_verified_apple_boost',args);
 if(error)throw error;
 return data;
}

