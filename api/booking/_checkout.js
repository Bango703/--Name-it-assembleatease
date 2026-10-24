import { needsScheduledAuthorization } from './_booking-window.js';
import { SALES_TAX_RATE } from '../_source-of-truth.js';

/**
 * How a cart is paid for, decided by the server for any client that books
 * natively (the customer iPhone app). The three answers match what
 * api/booking.js requires of the same cart:
 *   quote      custom-quote item or nothing priced: card saved, price sent to approve
 *   save_card  appointment past the immediate window: card saved, held later
 *   pay_now    card held now, charged after the job
 */
export const CHECKOUT_PLAN = Object.freeze({ PAY_NOW: 'pay_now', SAVE_CARD: 'save_card', QUOTE: 'quote' });

const PLAN_COPY = {
  [CHECKOUT_PLAN.PAY_NOW]: { button: 'Book now', note: 'You pay after the job is done.' },
  [CHECKOUT_PLAN.SAVE_CARD]: { button: 'Book now', note: 'Your card is saved. You pay after the job is done.' },
  [CHECKOUT_PLAN.QUOTE]: { button: 'Request a quote', note: 'We send you a price to approve. Nothing is booked until you approve it.' },
};

export function checkoutPlan({ totalCents, hasCustomQuote, date }) {
  const kind = (Number(totalCents) || 0) <= 0 || hasCustomQuote
    ? CHECKOUT_PLAN.QUOTE
    : (date && needsScheduledAuthorization(date) ? CHECKOUT_PLAN.SAVE_CARD : CHECKOUT_PLAN.PAY_NOW);
  return { kind, ...PLAN_COPY[kind] };
}

function taxLabel() {
  return `Sales tax (${Number((SALES_TAX_RATE * 100).toFixed(2))}%)`;
}

/**
 * The price breakdown a customer reads before booking, in the order and words
 * book.html uses. Rows add up to the total.
 */
export function checkoutSummary(pricingWithPromo, promo, assemblecash = null, giftCard = null) {
  const p = pricingWithPromo || {};
  const cents = (value) => Math.max(0, Math.round(Number(value) || 0));
  // AssembleCash, when applied, replaces the tax and total (_assemblecash.js totalsAfterAssembleCash).
  const credit = assemblecash && cents(assemblecash.redeemCents) > 0 ? assemblecash : null;
  const fullTotal = credit ? cents(credit.totals.totalCents) : cents(p.totalCents);
  // A gift card pays part of the total after tax (api/_gift-cards.js).
  const giftCents = giftCard ? Math.min(fullTotal, cents(giftCard.appliedCents)) : 0;
  const total = fullTotal - giftCents;
  const customOnly = !!p.hasCustomQuote && cents(p.itemSubtotalCents) === 0;
  const rows = [];
  if (total > 0) {
    rows.push({ label: 'Subtotal', cents: cents(p.itemSubtotalCents) });
    if (cents(p.discountCents) > 0) rows.push({ label: `Bundle discount (${p.discountPct}%)`, cents: -cents(p.discountCents) });
    if (cents(p.promoDiscountCents) > 0) rows.push({ label: promo?.label || 'Promo discount', cents: -cents(p.promoDiscountCents) });
    if (credit) rows.push({ label: 'AssembleCash applied', cents: -cents(credit.redeemCents) });
    if (cents(p.serviceCallFeeCents) > 0) rows.push({ label: 'Service call fee', cents: cents(p.serviceCallFeeCents) });
    if (cents(p.sameDayFeeCents) > 0) rows.push({ label: 'Same-day service', cents: cents(p.sameDayFeeCents) });
    rows.push({ label: taxLabel(), cents: credit ? cents(credit.totals.taxCents) : cents(p.taxCents) });
    if (giftCents > 0) rows.push({ label: `Gift card ending ${giftCard.last4}`, cents: -giftCents });
  }
  return {
    rows,
    total_cents: total,
    total_label: customOnly ? 'Custom quote' : 'Total',
    note: p.hasCustomQuote && !customOnly ? 'Some items are priced after a quote.' : null,
  };
}
