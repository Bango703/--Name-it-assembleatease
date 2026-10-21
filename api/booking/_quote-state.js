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
