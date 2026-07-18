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
