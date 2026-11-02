// Read-only diagnostics using the same server-configured Stripe client as payments.
// Do not return Account configuration, bank details, keys or Stripe error bodies.
const currencies=/^[a-z]{3}$/;
const unavailable=()=>({state:'unavailable'});
function amounts(rows){
 if(!Array.isArray(rows)||rows.some(r=>!currencies.test(r.currency)||!Number.isSafeInteger(r.amount)))throw Error('Invalid balance');
 return rows.map(({currency,amount})=>({currency,amount}));
}
export async function stripeAccountAudit(stripe,livemode,now=()=>new Date()){
 if(typeof livemode!=='boolean')throw Error('Invalid mode');
 const account=await stripe.accounts.retrieve();
 if(account?.object!=='account'||!/^acct_[A-Za-z0-9]+$/.test(account.id))throw Error('Account identity unavailable');
 const [balance,payouts]=await Promise.allSettled([stripe.balance.retrieve(),stripe.payouts.list({limit:10})]);
 let balanceResult=unavailable(),payoutResult=unavailable();
 if(balance.status==='fulfilled')try{
  const b=balance.value;if(b.object!=='balance'||b.livemode!==livemode)throw Error('Mode mismatch');
  balanceResult={state:'verified',available:amounts(b.available),pending:amounts(b.pending),connectReserved:b.connect_reserved===undefined?null:amounts(b.connect_reserved)};
 }catch{}
 if(payouts.status==='fulfilled')try{
  const p=payouts.value;
  if(p.object!=='list'||!Array.isArray(p.data)||p.data.length>10||typeof p.has_more!=='boolean')throw Error('Invalid payout list');
  const rows=p.data.map(x=>{
   if(x.object!=='payout'||!/^po_[A-Za-z0-9]+$/.test(x.id)||x.livemode!==livemode||!currencies.test(x.currency)
    ||!Number.isSafeInteger(x.amount)||x.amount<0||!['pending','in_transit','paid','failed','canceled'].includes(x.status)
    ||!Number.isSafeInteger(x.arrival_date)||x.arrival_date<=0||!Number.isSafeInteger(x.created)||x.created<=0)throw Error('Invalid payout');
   return {id:x.id,amount:x.amount,currency:x.currency,status:x.status,arrivalDate:new Date(x.arrival_date*1000).toISOString(),createdAt:new Date(x.created*1000).toISOString()};
  });
  payoutResult={state:'verified',rows,hasMore:p.has_more,limit:10};
 }catch{}
 return {accountId:account.id,livemode,observedAt:now().toISOString(),balance:balanceResult,payouts:payoutResult};
}
