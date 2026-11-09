// Local-only design prototype. No SDK, network, writes, or purchase imports.
// Dependencies must be read-only adapters; auth identity is server-derived.
const fields=['APPLE_IAP_PRIVATE_KEY','APPLE_IAP_ISSUER_ID','APPLE_IAP_KEY_ID','APPLE_VERIFIER_URL','APPLE_VERIFIER_SHARED_SECRET'];
const sku=/^com\.ayuhide\.koenofurima\.voice\.jpy[1-9][0-9]{0,7}$/;
function environment(raw){return {effective:raw==='Production'?'Production':'Sandbox',explicitValid:raw==='Production'||raw==='Sandbox'};}
export function configuration(getEnv){
 const voice=environment(getEnv('VOICE_IAP_ENVIRONMENT')),boost=environment(getEnv('BOOST_IAP_ENVIRONMENT'));
 const presence=Object.fromEntries(fields.map((k,i)=>[['signingKey','issuer','keyIdentifier','verifierEndpoint','verifierAuthentication'][i],Boolean(getEnv(k))]));
 let shape=false;
 try{const u=new URL(getEnv('APPLE_VERIFIER_URL'));shape=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(getEnv('APPLE_VERIFIER_SHARED_SECRET')||'').length>=32;}catch{}
 const appleMinimumValid=Object.values(presence).every(Boolean)&&shape;
 const key=getEnv('STRIPE_SECRET_KEY')||'';
 const stripeMode=/^(sk|rk)_live_/.test(key)?'Production':/^(sk|rk)_test_/.test(key)?'Sandbox':'unknown';
 return {voice:{enabled:getEnv('VOICE_IAP_ENABLED')==='true',environment:voice},boost:{enabled:getEnv('BOOST_IAP_ENABLED')==='true',environment:boost},apple:{configurationPresent:presence,minimumValid:appleMinimumValid,apiAndSignatureVerification:'unverified'},stripe:{mode:stripeMode,voiceModeMatches:stripeMode==='unknown'?null:stripeMode===voice.effective}};
}
function recipientResult(profile,account,mode){
 if(!profile||!/^acct_[A-Za-z0-9]+$/.test(profile.stripe_account_id||''))return {state:'not_ready',reason:'not_linked'};
 if(!account)return {state:'unknown',reason:'read_failed'};
 const expected=mode==='Production';
 if(account.id!==profile.stripe_account_id||typeof account.livemode!=='boolean')return {state:'unknown',reason:'response_unverified'};
 const capability=account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status;
 const entries=account.requirements?.entries;
 // Be stricter than prepare: incomplete returned requirements are not proof of readiness.
 if(typeof capability!=='string'||!Array.isArray(entries))return {state:'unknown',reason:'response_incomplete'};
 const due=entries.some(x=>x.awaiting_action_from==='user'&&['currently_due','past_due'].includes(x.minimum_deadline?.status));
 const ready=account.livemode===expected&&capability==='active'&&!due;
 return {state:ready?'ready':'not_ready',modeMatches:account.livemode===expected,transfersActive:capability==='active',requiresUserAction:due};
}
export async function diagnoseSelf({authenticate,getEnv,readOwnRecipient,readStripeRecipient,readCatalogue}){
 const user=await authenticate();
 if(!user?.id)throw new Error('AUTH_REQUIRED');
 const config=configuration(getEnv);
 // Never take seller ID, token, account ID, SKU or environment from request body.
 let recipient={state:'unknown',reason:'read_failed'};
 try{
  const profile=await readOwnRecipient(user.id);
  if(!profile)recipient={state:'unknown',reason:'response_unverified'};
  else if(profile.stripe_account_id===null||profile.stripe_account_id==='')recipient={state:'not_ready',reason:'not_linked'};
  else if(!/^acct_[A-Za-z0-9]+$/.test(profile.stripe_account_id||''))recipient={state:'unknown',reason:'response_unverified'};
  else if(config.stripe.mode==='unknown')recipient={state:'unknown',reason:'stripe_mode_unknown'};
  else recipient=recipientResult(profile,await readStripeRecipient(profile.stripe_account_id),config.voice.environment.effective);
 }catch{}
 let catalogue={state:'unknown',products:[]};
 try{
  const rows=await readCatalogue();
  if(!Array.isArray(rows)||rows.some(r=>!sku.test(r.product_id)||!Number.isSafeInteger(r.amount_jpy)||r.amount_jpy<50||r.amount_jpy>99999999||r.product_id!==`com.ayuhide.koenofurima.voice.jpy${r.amount_jpy}`||typeof r.sandbox_enabled!=='boolean'||typeof r.production_enabled!=='boolean'))throw Error('INVALID');
  catalogue={state:'read',products:rows.map(r=>({sku:r.product_id,amountJpy:r.amount_jpy,sandboxEnabled:r.sandbox_enabled,productionEnabled:r.production_enabled}))};
 }catch{}
 return {schemaVersion:1,scope:'authenticated_self_recipient_only',configuration:config,recipient,catalogue,purchaseReadiness:'unverified',limitations:['No buyer/listing eligibility checked','No Apple API or verifier call made','No StoreKit products checked','No purchase, order or recovery action performed']};
}
