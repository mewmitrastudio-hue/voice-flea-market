import {nativePurchaseGrant} from './native-purchase-grant.mjs';
// A normalized server receipt is classification, not a promise that excess
// money has been refunded or that StoreKit has finished the transaction.
export function nativePurchaseReceipt({tx,ownerId,result,backendUrl}){
 const binding=nativePurchaseGrant({tx,ownerId,result,backendUrl});
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const allowed=['winner','excess_payment_review','refunded_unfulfilled','refund_review_unfulfilled'];
 if(result.financiallyRecorded!==true||!uuid.test(result.intentId||'')||result.orderId?.toLowerCase()!==tx.appAccountToken.toLowerCase()||
  result.transactionId!==tx.transactionId||!allowed.includes(result.receiptClassification))throw Error('NATIVE_RECEIPT_UNCONFIRMED');
 const reviewRequired=result.reviewRequired===true||['excess_payment_review','refund_review_unfulfilled'].includes(result.receiptClassification);
 const winner=result.receiptClassification==='winner';
 return {...binding,version:3,intentId:result.intentId,receiptClassification:result.receiptClassification,
  financiallyRecorded:true,revoked:result.revoked===true,reviewRequired,
  fulfillmentGranted:winner&&!reviewRequired&&result.revoked!==true,
  finishAllowed:winner&&!reviewRequired};
}
