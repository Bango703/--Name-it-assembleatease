export const OWNER_OFFLINE_PAYMENT_METHODS = Object.freeze([
  'stripe_manual',
  'cash',
  'zelle',
  'cashapp',
  'card_on_site',
  'invoice',
]);

export function normalizeOwnerOfflinePaymentMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return OWNER_OFFLINE_PAYMENT_METHODS.includes(method) ? method : null;
}

// Per-method processing-fee rules for offline (owner-recorded) payments. An
// offline job just means the owner created it — the customer can still pay
// electronically. Card rails cost the processor's cut; cash and bank transfers
// cost nothing. These are fixed defaults in ONE place — edit a rate here and it
// applies everywhere an owner-manual fee is recorded.
//   pct        = fraction of the amount collected (0.029 = 2.9%)
//   fixedCents = flat per-transaction fee in cents
export const OFFLINE_METHOD_FEE_RULES = Object.freeze({
  cash:          { pct: 0,     fixedCents: 0 },   // no processor
  zelle:         { pct: 0,     fixedCents: 0 },   // bank transfer, free
  cashapp:       { pct: 0,     fixedCents: 0 },   // Cash App personal is free
  invoice:       { pct: 0,     fixedCents: 0 },   // assume ACH / check
  stripe_manual: { pct: 0.029, fixedCents: 30 },  // Stripe keyed card
  card_on_site:  { pct: 0.029, fixedCents: 30 },  // card terminal
});

// Processing fee the company pays for a given offline method + amount collected.
// Returns 0 for cash/bank rails, the card rate for card rails.
export function offlineMethodFeeCents(method, chargedCents) {
  const rule = OFFLINE_METHOD_FEE_RULES[String(method || '').trim().toLowerCase()];
  const charged = Math.max(0, Math.round(Number(chargedCents) || 0));
  if (!rule || charged <= 0) return 0;
  return Math.round(charged * rule.pct) + rule.fixedCents;
}
