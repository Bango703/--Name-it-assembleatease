import { safeTokenHashMatch } from '../_payment-security.js';

export const RECOVERABLE_PAYMENT_INTENT_STATUSES = Object.freeze([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

export const STANDARD_RECOVERY_PAYMENT_STATUSES = Object.freeze([
  'pending',
  'failed',
]);

export const QUOTE_PENDING_PAYMENT_STATUSES = Object.freeze([
  'quote_pending_approval',
  'quote_authorization_pending',
]);

export function isRecoverablePaymentIntentStatus(status) {
  return RECOVERABLE_PAYMENT_INTENT_STATUSES.includes(String(status || ''));
}

export function isStandardRecoveryBooking(booking = {}) {
  const paymentStatus = String(booking.payment_status || '');
  const initialPayment = booking.status === 'pending'
    && STANDARD_RECOVERY_PAYMENT_STATUSES.includes(paymentStatus);
  const confirmedPaymentHold = booking.status === 'confirmed'
    && booking.dispatch_status === 'payment_hold'
    && STANDARD_RECOVERY_PAYMENT_STATUSES.includes(paymentStatus);
  return (initialPayment || confirmedPaymentHold) && !!booking.stripe_payment_intent_id;
}

export function hasValidGuestPaymentToken(booking = {}, token) {
  return safeTokenHashMatch(token, booking.guest_mutation_token_hash);
}

export function validateBookingPaymentIntent(booking = {}, intent = {}, options = {}) {
  const expectedType = options.type || 'customer_booking';
  const expectedAmount = Number(options.amountCents ?? booking.total_price ?? 0);
  const expectedLiveMode = typeof options.expectedLiveMode === 'boolean'
    ? options.expectedLiveMode
    : String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
      ? true
      : (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? false : null);
  const intentCustomerId = typeof intent?.customer === 'string'
    ? intent.customer
    : intent?.customer?.id || null;
  const errors = [];

  if (!intent?.id || intent.id !== booking.stripe_payment_intent_id) errors.push('payment_intent_id');
  if (intent?.metadata?.bookingId !== booking.id) errors.push('booking_metadata');
  if (intent?.metadata?.type !== expectedType) errors.push('payment_type');
  if (intent?.currency !== 'usd') errors.push('currency');
  if (intent?.capture_method !== 'manual') errors.push('capture_method');
  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0 || intent?.amount !== expectedAmount) errors.push('amount');
  if (booking.stripe_customer_id && intentCustomerId !== booking.stripe_customer_id) errors.push('stripe_customer_id');
  if (expectedLiveMode != null && intent?.livemode !== expectedLiveMode) errors.push('livemode');

  return {
    ok: errors.length === 0,
    errors,
    expectedAmount,
    expectedType,
  };
}

export function classifyPendingExpiry(booking = {}, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const staleBeforeMs = Number(options.staleBeforeMs ?? nowMs);
  if (booking.status !== 'pending') return { eligible: false, reason: 'not_pending' };

  const paymentStatus = String(booking.payment_status || '');
  const createdAtMs = Date.parse(booking.created_at || '');
  const createdIsStale = Number.isFinite(createdAtMs) && createdAtMs < staleBeforeMs;

  if (QUOTE_PENDING_PAYMENT_STATUSES.includes(paymentStatus)) {
    const quoteExpiresMs = Date.parse(booking.quote_expires_at || '');
    if (!Number.isFinite(quoteExpiresMs)) {
      return { eligible: false, reason: 'quote_expiry_missing', requiresReconciliation: true };
    }
    return quoteExpiresMs <= nowMs
      ? { eligible: true, kind: 'quote', paymentStatus }
      : { eligible: false, reason: 'quote_not_expired' };
  }

  if (paymentStatus === 'card_saved') {
    return createdIsStale
      ? { eligible: true, kind: 'quote_request', paymentStatus }
      : { eligible: false, reason: 'quote_request_not_stale' };
  }

  if (STANDARD_RECOVERY_PAYMENT_STATUSES.includes(paymentStatus)) {
    return createdIsStale
      ? { eligible: true, kind: 'standard_payment', paymentStatus }
      : { eligible: false, reason: 'payment_not_stale' };
  }

  if (paymentStatus === 'not_required') {
    return createdIsStale
      ? { eligible: true, kind: 'no_payment_request', paymentStatus }
      : { eligible: false, reason: 'request_not_stale' };
  }

  return { eligible: false, reason: 'unsupported_payment_state', requiresReconciliation: true };
}
