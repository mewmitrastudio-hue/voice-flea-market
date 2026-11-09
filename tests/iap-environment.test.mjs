import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseEnvironments,preparationEnvironment,recipientEnvironment} from '../supabase/functions/_shared/iap-environment.mjs';
for(const mode of ['Sandbox','Production'])test(`${mode} explicit single mode stays backward compatible and rejects an opposing hint`,()=>{
 assert.equal(preparationEnvironment(mode,undefined),mode);
 assert.equal(preparationEnvironment(mode,mode),mode);
 assert.throws(()=>preparationEnvironment(mode,mode==='Sandbox'?'Production':'Sandbox'));
});
test('Dual accepts only explicit StoreKit routing hints, never unknown or missing environments',()=>{
 assert.deepEqual(purchaseEnvironments('Dual'),['Sandbox','Production']);
 for(const env of ['Sandbox','Production'])assert.equal(preparationEnvironment('Dual',env),env);
 for(const hint of [undefined,null,'dual','Xcode','Production ',{},true])assert.throws(()=>preparationEnvironment('Dual',hint));
 for(const mode of [undefined,'','dual','garbage'])assert.throws(()=>preparationEnvironment(mode,'Sandbox'));
});
test('dual review and real purchases check the same live seller, never a client selected Stripe account',()=>{
 for(const env of ['Sandbox','Production']){
  assert.equal(recipientEnvironment('Dual',env,'sk_live_fixture'),'Production');
  for(const key of ['sk_test_fixture','','invalid'])assert.throws(()=>recipientEnvironment('Dual',env,key));
 }
 assert.equal(recipientEnvironment('Sandbox','Sandbox','sk_test_fixture'),'Sandbox');
 assert.throws(()=>recipientEnvironment('Sandbox','Sandbox','sk_live_fixture'));
 assert.throws(()=>recipientEnvironment('Production','Production','sk_test_fixture'));
});
