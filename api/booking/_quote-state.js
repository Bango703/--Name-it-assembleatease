import { openBookingSlots } from './_booking-slots.js';

// What a custom quote is, before it is priced. One rule for the server
// (api/owner/quote-approve.js); owner/index.html quoteLane mirrors it and
// scripts/test-quote-no-card.mjs holds the two together.
//
// Since 2026-10-21 a quote is sent without a card. api/booking.js saves it as
// pending, payment_status 'not_required', payment_method_type 'card' (a card is
// collected on approval). Only a quote produces that combination: an instant
// booking is 'pending' payment, a scheduled booking is 'card_saved', and a
// no-charge booking has no payment method type. Quotes sent before the change
// carry 'card_saved'.

export function isQuoteAwaitingPrice(booking = {}) {
  if (booking.status !== 'pending') return false;
  const pay = String(booking.payment_status || '');
  if (pay === 'card_saved') return true;
  return pay === 'not_required' && booking.payment_method_type === 'card';
}

/** The quote has no saved card: the customer adds one on the approval page. */
export function quoteNeedsCardAtApproval(booking = {}) {
  return !booking.stripe_payment_method_id;
}

/**
 * A custom quote the customer has not approved yet: waiting on the owner's
 * price, on the customer, or mid-approval. Not a job: dispatch only ever sees it
 * after approval confirms it, and the owner alerts must not call it a stranded
 * paid booking. Its total_price is the preliminary cart estimate, never the
 * quote (owner, 2026-10-28: Tyler Finn's Smart Home request was reported as a
 * $353.98 paid booking dispatch gave up on; the quote he was sent was $650).
 */
export const QUOTE_SENT_PAYMENT_STATUSES = Object.freeze(['quote_pending_approval', 'quote_authorization_pending']);

export function isOpenCustomQuote(booking = {}) {
  if (booking.status !== 'pending') return false;
  return isQuoteAwaitingPrice(booking) || QUOTE_SENT_PAYMENT_STATUSES.includes(String(booking.payment_status || ''));
}

/** booking.time in the stored en-dash form ('2:00 PM – 4:00 PM'). */
export function normalizeQuoteSlot(time) {
  return String(time || '').trim().replace(/\s*[-–—]\s*/g, ' – ');
}

/**
 * Can this quote still be approved for its date and time? The same rule a
 * customer meets booking that slot now (api/booking/_booking-slots.js): the
 * window has not started and a same-day window keeps its lead time. A request
 * for "today 2-4 PM" that is approved tomorrow would otherwise confirm a past
 * appointment and send it straight to Easers.
 */
export function quoteSlotStillOpen(booking = {}, now = new Date()) {
  if (!booking.date) return false;
  return openBookingSlots(booking.date, now).includes(normalizeQuoteSlot(booking.time));
}
