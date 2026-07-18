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

// Offline rails with no card processor behind them — the platform pays no Stripe
// fee, so financial summaries must record $0 instead of estimating a phantom fee.
// stripe_manual, card_on_site, and invoice can carry a real (unknown) fee, so
// they are intentionally excluded and left to the standard estimate.
export const NO_PROCESSOR_FEE_METHODS = Object.freeze(['cash', 'zelle', 'cashapp']);

export function offlineMethodHasNoProcessorFee(value) {
  return NO_PROCESSOR_FEE_METHODS.includes(String(value || '').trim().toLowerCase());
}
