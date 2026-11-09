// Issued only after the existing verifier and durable, owner-checked RPC succeed.
// Never derive the project or transaction identity from request fields.
export function nativePurchaseGrant({tx,ownerId,result,backendUrl}){
 const project=new URL(backendUrl);
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(project.protocol!=='https:'||project.hostname!=='tyulybijubckitybgubc.supabase.co'||project.port||project.username||project.password||
    !result||(result.environment!==tx.environment && !(result.revoked===true && result.environment===undefined))||!uuid.test(ownerId)||!uuid.test(tx.appAccountToken)||
    !/^\d{1,40}$/.test(tx.transactionId)||!['Sandbox','Production'].includes(tx.environment)||
    tx.currency!=='JPY'||!Number.isSafeInteger(tx.price)||tx.price<=0||tx.price%1000!==0)throw Error('NATIVE_GRANT_UNCONFIRMED');
 return {version:1,backendProjectRef:'tyulybijubckitybgubc',ownerId,transactionId:tx.transactionId,
  orderId:tx.appAccountToken,productId:tx.productId,environment:tx.environment,amountJpy:tx.price/1000};
}
