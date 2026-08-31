export const BOOKING_PAYMENT_METHOD = Object.freeze({
  CARD: 'card',
  KLARNA: 'klarna',
});

export function normalizeBookingPaymentMethod(value) {
  const normalized = String(value || BOOKING_PAYMENT_METHOD.CARD).trim().toLowerCase();
  return Object.values(BOOKING_PAYMENT_METHOD).includes(normalized) ? normalized : null;
}

export function isKlarnaEnabled() {
  return String(process.env.KLARNA_ENABLED || '').trim().toLowerCase() === 'true';
}

export function getKlarnaEligibility({
  enabled = isKlarnaEnabled(),
  quoteRequested = false,
  scheduledAuthorization = false,
  accountMode = '',
  amountCents = 0,
} = {}) {
  if (!enabled) return { eligible: false, reason: 'disabled' };
  if (quoteRequested) return { eligible: false, reason: 'custom_quote' };
  if (scheduledAuthorization) return { eligible: false, reason: 'future_booking' };
  if (String(accountMode || '').trim().toLowerCase() === 'business') {
    return { eligible: false, reason: 'business_booking' };
  }
  if (!Number.isInteger(Number(amountCents)) || Number(amountCents) <= 0) {
    return { eligible: false, reason: 'invalid_amount' };
  }
  return { eligible: true, reason: null };
}
