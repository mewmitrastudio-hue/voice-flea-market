import vm from 'node:vm';
// Existing workflow unit tests exercise authorized payment behavior in isolation.
// This explicitly mocks only the permission boundary, not its production policy.
// Recording-policy tests load the real helpers and must not use this fixture.
export function paymentBehaviorContext(values={}){
 Object.assign(values,{recordingApplePurchasesAllowed:()=>true,recordingAppleRecoveryAllowed:()=>true,recordingStripeReadsAllowed:()=>true,recordingStripeWritesAllowed:()=>true});
 return vm.createContext(values);
}
