import { BOOKING_STATUS } from '../_source-of-truth.js';
import { BOOKING_PAYMENT_METHOD, normalizeBookingPaymentMethod } from './_payment-method.js';

// Moving a held-card booking past the immediate authorization window (owner,
// 2026-11-08). An Easer could not move a reassigned job, and the customer would
// have been told to contact support, because a card hold was in place and the
// new date was more than two days out. That was our hold mechanics, not the
// bank (Rule 16). The booking now goes back to a saved card, exactly as if it
// had been booked that far ahead: the hold is released and
// api/cron/authorize-scheduled-payments.js places a fresh one two days before.
//
// Order is what keeps this safe. The booking row changes first, under the
// reschedule's own compare-and-set, so it never points at a released hold.
// The old hold is released after. If that release fails, the hold is not
// referenced by anything, is never captured, and lapses on its own; the
// payment_intent.canceled webhook ignores it as stale.

/**
 * True when this booking's hold can be released and re-placed later off-session
 * without the customer: a confirmed card booking whose saved card and customer
 * are on file. Klarna cannot be authorized off-session; a deposit or a missing
 * amount is left alone.
 */
export function heldCardCanWait(booking = {}) {
  return booking.status === BOOKING_STATUS.CONFIRMED
    && booking.payment_status === 'authorized'
    && normalizeBookingPaymentMethod(booking.payment_method_type) === BOOKING_PAYMENT_METHOD.CARD
    && Boolean(booking.stripe_payment_intent_id && booking.stripe_customer_id && booking.stripe_payment_method_id)
    && !booking.stripe_deposit_intent_id
    && Number.isInteger(Number(booking.total_price)) && Number(booking.total_price) > 0;
}

/** The columns that turn a held booking back into a saved-card booking. */
export const SAVED_CARD_FIELDS = Object.freeze({
  payment_status: 'card_saved',
  stripe_payment_intent_id: null,
  payment_authorized_at: null,
  authorization_capture_before: null,
});

/**
 * Release the hold the booking no longer points at. Never throws. A hold that
 * Stripe already reports as canceled counts as released.
 */
export async function releaseSupersededHold({ stripe, bookingId, paymentIntentId }) {
  if (!stripe || !paymentIntentId) return { ok: false, error: 'stripe_unavailable' };
  try {
    await stripe.paymentIntents.cancel(
      paymentIntentId,
      { cancellation_reason: 'requested_by_customer' },
      { idempotencyKey: `reschedule-release-${bookingId}-${paymentIntentId}` },
    );
    return { ok: true };
  } catch (error) {
    try {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent?.status === 'canceled') return { ok: true };
    } catch { /* the original error is the one reported */ }
    return { ok: false, error: error?.message || String(error) };
  }
}
