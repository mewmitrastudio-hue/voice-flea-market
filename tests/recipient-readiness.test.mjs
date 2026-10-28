import test from 'node:test';
import assert from 'node:assert/strict';
import {requireRecipient} from '../supabase/functions/_shared/recipient-readiness.mjs';
function fixture(overrides={}){const calls=[],seller={id:'seller',stripe_account_id:'acct_seller',...overrides.profile},account={id:'acct_seller',livemode:false,configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{status:'active'}}}}},requirements:{entries:[]},...overrides.account};return {calls,admin:{from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:seller})})},stripe:{v2:{core:{accounts:{retrieve:async(...args)=>{calls.push(args);return account;}}}}}};}
test('recipient readiness uses authoritative v2 capability and matching environment, not the cached verification badge',async()=>{
 const f=fixture({profile:{verified:false}});assert.equal(await requireRecipient({...f,sellerId:'seller',live:false}),'acct_seller');assert.equal(f.calls[0][0],'acct_seller');
 for(const options of [{profile:{id:'other'}},{profile:{stripe_account_id:null}},{account:{livemode:true}},{account:{id:'acct_other'}},{account:{configuration:{recipient:{capabilities:{stripe_balance:{stripe_transfers:{status:'inactive'}}}}}}},{account:{requirements:{entries:[{awaiting_action_from:'user',minimum_deadline:{status:'past_due'}}]}}}]){
  const x=fixture(options);await assert.rejects(requireRecipient({...x,sellerId:'seller',live:false}),/recipient_not_ready/);
 }
});
