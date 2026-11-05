// A deployment identity boundary, not a sales feature flag. Apple enablement
// must never grant Stripe write access to the isolated recording project.
const production = 'https://tyulybijubckitybgubc.supabase.co';
const recording = 'https://neotkrfsquysuatdruhg.supabase.co';
export function paymentDeployment(url) {
  if (url === production || url === production + '/') return 'production';
  if (url === recording || url === recording + '/') return 'recording';
  return null;
}
export function stripeWritesAllowed(url) {
  return paymentDeployment(url) === 'production';
}
export const stripeWriteBlocked = Object.freeze({
  error: 'この環境ではStripeの決済操作を開始できません。',
  code: 'stripe_writes_forbidden',
});
