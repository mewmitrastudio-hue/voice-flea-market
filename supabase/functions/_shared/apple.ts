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
 // Only the existing verifier constructs this internal current-proof property.
 // All runtime callers (including by-ID settlement/delivery paths) preserve it.
 // Missing proof keeps unrelated legacy compatibility but cannot bypass the
 // Stage1 SQL gate for an opted-in order.
 const currentSigned=Object.prototype.hasOwnProperty.call(tx,'verifiedSignedTransaction')?tx.verifiedSignedTransaction:null;
 const hasSigned=typeof currentSigned==='string'&&currentSigned.length>0&&currentSigned.length<=30000;
 if(currentSigned!==null&&!hasSigned)throw Error('APPLE_CURRENT_PROOF_MISSING');
 const currentRefund={refundEvidenceVersion:tx.refundEvidenceVersion??null,revocationDate:tx.revocationDate??null,
  revocationType:tx.revocationType??null,revocationPercentage:tx.revocationPercentage??null};
 const submittedRefund=Object.prototype.hasOwnProperty.call(tx,'submittedRefundEvidence')?tx.submittedRefundEvidence:null;
 const submittedHasRefund=submittedRefund&&['revocationDate','revocationType','revocationPercentage'].some(k=>submittedRefund[k]!==null&&submittedRefund[k]!==undefined);
 const refundConflict=Boolean(submittedHasRefund&&Object.keys(currentRefund).some(k=>submittedRefund[k]!==currentRefund[k]));
 const refundUncertain=(tx.revocationDate!==undefined && (!Number.isFinite(tx.revocationDate)||tx.revocationDate<=0||tx.refundEvidenceVersion!==1||
  (tx.revocationType!==undefined&&tx.revocationType!=='REFUND_FULL')||(tx.revocationPercentage!==undefined&&tx.revocationPercentage!==100000)))||
  (tx.revocationDate===undefined&&(tx.revocationType!==undefined||tx.revocationPercentage!==undefined));
 if(hasSigned&&(refundUncertain||refundConflict)){
  // Both inputs were independently verified and immutable identity compared by
  // the adapter. A conflicting signed refund is not erased by a positive
  // by-ID observation, nor promoted to an authoritative full refund.
  const observationSigned=refundConflict?tx.submittedSignedTransaction:currentSigned;
  const evidence=refundConflict?{...submittedRefund,competingCurrentRefundEvidence:currentRefund}:currentRefund;
  const {data:review,error:reviewError}=await admin.rpc('record_native_refund_observation',{
   order_id:tx.appAccountToken,tx_id:tx.transactionId,sku:tx.productId,tx_environment:tx.environment,
   purchased_at:new Date(tx.purchaseDate).toISOString(),price_milliunits:tx.price??null,currency:tx.currency??null,
   evidence,signed_transaction:observationSigned,actor
  });
  if(reviewError||!review)throw Error('APPLE_REFUND_HOLD_NOT_CONFIRMED');
  if(review.handled===true){
   for(const proof of [currentSigned,tx.submittedSignedTransaction])if(typeof proof==='string'&&proof!==observationSigned){
    const {error:proofError}=await admin.rpc('retain_native_verified_evidence',{
     actor,order_id:tx.appAccountToken,tx_id:tx.transactionId,tx_environment:tx.environment,signed_transaction:proof});
    if(proofError)throw Error('APPLE_REFUND_HOLD_NOT_CONFIRMED');
   }
   throw Error('APPLE_REFUND_REVIEW_HELD');
  }
  if(review.handled!==false)throw Error('APPLE_REFUND_HOLD_NOT_CONFIRMED');
  if(refundConflict){
   // Preserve existing legacy voice hold where its contract accepts this
   // evidence. No inconsistent proof may fall through to a positive grant.
   if(/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(tx.productId||'')){
    const {error}=await admin.rpc('record_apple_refund_review',{order_id:tx.appAccountToken,tx_id:tx.transactionId,tx_environment:tx.environment,
     sku:tx.productId,price_milliunits:tx.price,currency:tx.currency,actor,evidence});
    if(error)throw Error('APPLE_REFUND_HOLD_NOT_CONFIRMED');
    throw Error('APPLE_REFUND_REVIEW_HELD');
   }
   throw Error('APPLE_REFUND_RECONCILIATION_REQUIRED');
  }
 }

 // A revocation date alone no longer proves a full refund. The signature
 // service must preserve current Apple refund fields; an older worker cannot
 // silently erase a prorated refund and authorize full seller recovery.
 const hasRevocation=tx.revocationDate!==undefined;
 if(hasRevocation && (!Number.isFinite(tx.revocationDate) || tx.revocationDate<=0 || tx.refundEvidenceVersion!==1 ||
    (tx.revocationType!==undefined && tx.revocationType!=='REFUND_FULL') ||
    (tx.revocationPercentage!==undefined && tx.revocationPercentage!==100000))) {
  if(tx.refundEvidenceVersion===1 && Number.isFinite(tx.revocationDate) && tx.revocationDate>0 &&
     /^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(tx.productId||'')) {
   const {error}=await admin.rpc('record_apple_refund_review',{
    order_id:tx.appAccountToken,tx_id:tx.transactionId,tx_environment:tx.environment,
    sku:tx.productId,price_milliunits:tx.price,currency:tx.currency,actor,
    evidence:{refundEvidenceVersion:1,revocationDate:tx.revocationDate,
     revocationType:tx.revocationType??null,revocationPercentage:tx.revocationPercentage??null}
   });
   if(error)throw new Error('APPLE_REFUND_HOLD_NOT_CONFIRMED');
   throw new Error('APPLE_REFUND_REVIEW_HELD');
  }
  throw new Error('APPLE_REFUND_RECONCILIATION_REQUIRED');
 }
 if(!hasRevocation && (tx.revocationType!==undefined || tx.revocationPercentage!==undefined)) {
  throw new Error('APPLE_REFUND_EVIDENCE_INCONSISTENT');
 }

 const voice=/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/.test(tx.productId||'');
 const args:any={order_id:tx.appAccountToken,tx_id:tx.transactionId,sku:tx.productId,tx_environment:tx.environment,purchased_at:new Date(tx.purchaseDate).toISOString(),revoked:Boolean(tx.revocationDate)};
 Object.assign(args,{price_milliunits:tx.price??null,currency:tx.currency??null});
 if(voice||actor!==null)Object.assign(args,{actor});
 if(hasSigned){
  const {data,error}=await admin.rpc('apply_native_verified_receipt',{...args,actor,signed_transaction:currentSigned});
  if(error||!data)throw error||Error('APPLE_RECEIPT_NOT_RECORDED');
  if(data.financiallyRecorded===true&&typeof tx.submittedSignedTransaction==='string'&&tx.submittedSignedTransaction!==currentSigned){
   const {error:proofError}=await admin.rpc('retain_native_verified_evidence',{
    actor,order_id:tx.appAccountToken,tx_id:tx.transactionId,tx_environment:tx.environment,signed_transaction:tx.submittedSignedTransaction});
   if(proofError)throw Error('APPLE_RECEIPT_EVIDENCE_NOT_RECORDED');
  }
  if(data.reviewRequired===true&&data.receiptClassification!=='excess_payment_review')throw Error('APPLE_REFUND_REVIEW_HELD');
  return data;
 }
 const {data,error}=await admin.rpc(voice?'apply_verified_apple_voice':actor!==null?'apply_owned_priced_apple_boost':'apply_priced_apple_boost',args);
 if(error)throw error;
 return data;
}

