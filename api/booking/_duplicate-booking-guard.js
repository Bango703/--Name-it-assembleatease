// Duplicate-booking guard.
//
// /api/booking creates the booking row before the card is authorized, so a
// declined card leaves a real pending+unpaid booking behind. Nothing cleans it
// up, and the next attempt used to create another one — a customer whose card
// failed three times produced three bookings, three AAE- references, three rows
// in the owner's queue, and three cancellation emails when the owner cleared
// them out.
//
// These helpers decide when it is safe to land a retry on the booking that
// already exists instead of minting a new one. They are pure so the decision
// can be tested without Supabase or Stripe.

// How long after creation an unpaid booking is still considered the same
// checkout attempt rather than a genuine second booking of the same slot.
export const UNPAID_BOOKING_REUSE_WINDOW_MS = 2 * 60 * 60 * 1000;

// A declined card leaves the PaymentIntent in one of these — still confirmable
// with another card, which is exactly what a retry needs.
const REUSABLE_INTENT_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
]);

// The card already went through. Confirming again would authorize a second
// hold on the customer's card.
const AUTHORIZED_INTENT_STATUSES = new Set([
  'requires_capture',
  'succeeded',
  'processing',
]);

/**
 * Is this cart eligible for the reuse path at all?
 *
 * A promo code or an AssembleCash token holds a redemption reservation bound to
 * the original booking ref. Re-pointing one at a different booking is a money
 * change, not a de-duplication, so those carts always take the normal create
 * path and are allowed to duplicate as they did before.
 */
export function cartAllowsBookingReuse({ hasPromo, hasAssembleCash }) {
  return !hasPromo && !hasAssembleCash;
}

/**
 * Is this stored booking row a safe landing spot for the retry?
 *
 * The row must still be unpaid and unassigned, and its stored total — the money
 * truth for that booking — must match what this attempt priced. A mismatch
 * means the cart changed, and reusing the row would charge the wrong amount.
 */
export function isReusableBookingRow(row, { amountCents }) {
  if (!row) return false;
  if (Number(row.total_price) !== Number(amountCents)) return false;
  if (row.promo_code) return false;
  if (Number(row.assemblecash_redeemed_cents || 0) > 0) return false;
  if (!row.stripe_payment_intent_id) return false;
  return true;
}

/**
 * What should happen with the PaymentIntent already attached to that booking?
 *
 * Stripe is the financial truth here, so the intent's own amount is checked
 * against this attempt before anything is reused.
 *
 * @returns {'reuse'|'replace'|'already_authorized'|'unusable'}
 */
export function classifyExistingIntent(intent, { amountCents, paymentMethodType } = {}) {
  if (!intent) return 'unusable';
  if (Number(intent.amount) !== Number(amountCents)) return 'unusable';
  if (AUTHORIZED_INTENT_STATUSES.has(intent.status)) return 'already_authorized';
  const requestedMethod = String(paymentMethodType || '').trim().toLowerCase();
  const intentMethods = Array.isArray(intent.payment_method_types) && intent.payment_method_types.length
    ? intent.payment_method_types
    : ['card'];
  if (requestedMethod && !intentMethods.includes(requestedMethod)) {
    return REUSABLE_INTENT_STATUSES.has(intent.status) || intent.status === 'canceled'
      ? 'replace'
      : 'unusable';
  }
  if (REUSABLE_INTENT_STATUSES.has(intent.status) && intent.client_secret) return 'reuse';
  return 'unusable';
}
