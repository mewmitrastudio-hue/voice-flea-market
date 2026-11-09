// A preparation hint is never receipt authority. Grants require Apple verification
// and the immutable order environment; this module creates no entitlement.
export function purchaseEnvironments(configured) {
 if (configured === 'Dual') return ['Sandbox', 'Production'];
 if (configured === 'Sandbox' || configured === 'Production') return [configured];
 return [];
}
export function preparationEnvironment(configured, hint) {
 const allowed = purchaseEnvironments(configured);
 // Legacy clients may omit the hint only for an explicitly single-mode server.
 const selected = hint === undefined && allowed.length === 1 ? allowed[0] : hint;
 if (!allowed.includes(selected)) throw new Error('IAP_ENVIRONMENT_UNAVAILABLE');
 return selected;
}
export function recipientEnvironment(configured, purchaseEnvironment, stripeKey) {
 const mode = /^(sk|rk)_live_/.test(stripeKey) ? 'Production'
   : /^(sk|rk)_test_/.test(stripeKey) ? 'Sandbox' : null;
 // Dual serves the real application. Both review and paid buyers must resolve
 // the real seller's LIVE recipient. Sandbox payments remain Sandbox, with no
 // proceeds or transfer authority; never switch recipient accounts from a hint.
 if (configured === 'Dual' ? mode !== 'Production' : mode !== purchaseEnvironment)
   throw new Error('IAP_RECIPIENT_ENVIRONMENT_UNAVAILABLE');
 return mode;
}
