// A profile's cached badge is not authority to move funds. Check the recipient
// using the same Stripe environment that will eventually settle the purchase.
export async function requireRecipient({admin,sellerId,stripe,live}){
 const {data:seller,error}=await admin.from('profiles').select('id,stripe_account_id').eq('id',sellerId).maybeSingle();
 if(error||!seller||seller.id!==sellerId||!/^acct_[A-Za-z0-9]+$/.test(seller.stripe_account_id||''))throw new Error('recipient_not_ready');
 const account=await stripe.v2.core.accounts.retrieve(seller.stripe_account_id,{include:['configuration.recipient','requirements']});
 const status=account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
 const needsAction=(account.requirements?.entries||[]).some(x=>x.awaiting_action_from==='user'&&['currently_due','past_due'].includes(x.minimum_deadline?.status));
 if(account.id!==seller.stripe_account_id||account.livemode!==live||status!=='active'||needsAction)throw new Error('recipient_not_ready');
 return account.id;
}
