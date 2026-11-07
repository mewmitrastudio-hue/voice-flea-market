import {verifyApplePayoutEvidence} from './apple-payout-evidence.mjs';
const idOf=x=>typeof x==='string'?x:x?.id;
const valid=(x,prefix)=>typeof x==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(x);
const pick=(x,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(x,k)).map(k=>[k,x[k]]));
const transferKeys=['object','id','amount','currency','destination','destination_payment','livemode','amount_reversed','reversed','source_transaction','metadata','transfer_group'];
const chargeKeys=['object','id','source_transfer','balance_transaction','amount','amount_captured','captured','paid','status','currency','livemode','amount_refunded','refunded','disputed','failure_balance_transaction','failure_code','failure_message'];
const payoutKeys=['object','id','amount','currency','livemode','destination','automatic','method','reconciliation_status','type','status','failure_balance_transaction','failure_code','failure_message','reversed_by','original_payout'];
const rowKeys=['object','id','source','amount','fee','net','currency','status'];
// Trusted server SDK only. GET requests, no writes or permission changes.
// Bank statement review remains a separate authenticated human attestation.
export async function collectApplePayoutEvidence({stripe,operation:op,payoutId,bankAccountId,nowMs,maxAgeMs,maxPages=100}){
 if(!op||!valid(op.platform_id,'acct')||!valid(op.destination,'acct')||op.destination===op.platform_id||!valid(op.transfer_id,'tr')||op.livemode!==true||op.currency!=='jpy'||!valid(payoutId,'po')||!valid(bankAccountId,'ba')||!Number.isInteger(maxPages)||maxPages<1||maxPages>1000||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0)throw Error('apple_payout_collection_input_invalid');
 const clock=()=>nowMs??Date.now();
 const context=(response,accountId)=>{
  const r=response?.lastResponse;
  if(!r||!valid(r.requestId,'req')||r.statusCode!==200||typeof (r.apiVersion||r.headers?.['stripe-version'])!=='string'||(r.stripeAccount&&r.stripeAccount!==accountId))throw Error('apple_payout_response_context_invalid');
  return {source:'stripe_server_api',accountId,livemode:true,requestId:r.requestId,apiVersion:r.apiVersion||r.headers['stripe-version'],retrievedAtMs:clock()};
 };
 const account=await stripe.accounts.retrieve();
 context(account,op.platform_id);
 if(account.id!==op.platform_id)throw Error('apple_payout_platform_mismatch');
 const scope={stripeAccount:op.destination};
 let transfer=await stripe.transfers.retrieve(op.transfer_id);
 let transferContext=context(transfer,op.platform_id);
 if(idOf(transfer.destination)!==op.destination||transfer.livemode!==true||!valid(idOf(transfer.destination_payment),'py'))throw Error('apple_payout_transfer_identity_mismatch');
 const paymentId=idOf(transfer.destination_payment);
 const bank=await stripe.accounts.retrieveExternalAccount(op.destination,bankAccountId);
 const bankContext=context(bank,op.platform_id); // account appears in URL, not Stripe-Account header
 if(bank.object!=='bank_account'||bank.id!==bankAccountId||bank.deleted===true||bank.currency!=='jpy'||(bank.account&&idOf(bank.account)!==op.destination)||!['new','validated','verified'].includes(bank.status))throw Error('apple_payout_bank_account_mismatch');
 const rows=[],pageContexts=[];let startingAfter,complete=false;
 for(let page=0;page<maxPages;page++){
  const params={payout:payoutId,limit:100,...(startingAfter?{starting_after:startingAfter}:{})};
  const response=await stripe.balanceTransactions.list(params,scope);
  pageContexts.push(context(response,op.destination));
  if(response.object!=='list'||typeof response.has_more!=='boolean'||!Array.isArray(response.data))throw Error('apple_payout_page_invalid');
  rows.push(...response.data.map(row=>pick(row,rowKeys)));
  if(!response.has_more){complete=true;break;}
  const next=response.data.at(-1)?.id;
  if(!valid(next,'txn')||next===startingAfter||response.data.length===0)throw Error('apple_payout_pagination_stalled');
  startingAfter=next;
 }
 if(!complete)throw Error('apple_payout_pagination_incomplete');
 // Re-fetch after pagination: never certify the stale first transfer or an
 // earlier payout snapshot if a reversal/failure occurred during collection.
 transfer=await stripe.transfers.retrieve(op.transfer_id);transferContext=context(transfer,op.platform_id);
 if(idOf(transfer.destination_payment)!==paymentId)throw Error('apple_payout_transfer_changed');
 const charge=await stripe.charges.retrieve(paymentId,{},scope);const chargeContext=context(charge,op.destination);
 const payout=await stripe.payouts.retrieve(payoutId,{},scope);const payoutContext=context(payout,op.destination);
 const evidence={
  transfer:{data:pick(transfer,transferKeys),context:transferContext},
  destinationPayment:{data:pick(charge,chargeKeys),context:chargeContext},
  payout:{data:pick(payout,payoutKeys),context:payoutContext},
  payoutTransactions:{data:{object:'list',has_more:false,data:rows},context:{...pageContexts.at(-1),payoutId,paginationComplete:true,pageContexts}},
  bankOwnership:{bankAccountId,connectedAccountId:op.destination,currency:bank.currency,context:bankContext}
 };
 // Keep only identity references; never persist expanded customer/bank objects.
 for(const [data,keys] of [[evidence.transfer.data,['destination','destination_payment','source_transaction']],[evidence.destinationPayment.data,['source_transfer','balance_transaction','failure_balance_transaction']],[evidence.payout.data,['destination','failure_balance_transaction','reversed_by','original_payout']]])for(const key of keys)if(data[key]&&typeof data[key]==='object')data[key]=idOf(data[key]);
 evidence.transfer.data.metadata=pick(transfer.metadata||{},['apple_settlement_id','payment_id']);
 for(const row of rows)if(row.source&&typeof row.source==='object')row.source=idOf(row.source);
 const now=clock();
 for(const c of [...pageContexts,bankContext])if(now-c.retrievedAtMs>maxAgeMs||c.retrievedAtMs>now)throw Error('apple_payout_collection_stale');
 const expected={platformId:op.platform_id,destination:op.destination,transferId:op.transfer_id,payoutId,bankAccountId,currency:op.currency,livemode:op.livemode,amountJpy:op.amount_jpy,settlementId:op.id,paymentId:op.payment_id};
 const verification=verifyApplePayoutEvidence({expected,...evidence,nowMs:now,maxAgeMs});
 return {verification,evidence};
}
