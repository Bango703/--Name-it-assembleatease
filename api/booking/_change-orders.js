import { getSupabase } from '../_supabase.js';
import { SALES_TAX_RATE, ACTIVE_BOOKING_STATUSES, BOOKING_STATUS } from '../_source-of-truth.js';
import { BOOKING_PAYMENT_METHOD } from './_payment-method.js';

/**
 * THE change-order domain. Every rule about additional scope on a live booking
 * lives here — statuses, eligibility, money, and what counts toward the total.
 *
 * A change order is work discovered after the booking was authorized: a wall
 * that needs anchoring, a floor that needs levelling, an extra item. Before this
 * existed the price was frozen once Stripe held money, so that work was either
 * done free or collected off-platform where it is untaxed, untracked, and never
 * reaches the Easer's payout.
 *
 * NON-NEGOTIABLES:
 *   - The customer approves BEFORE any charge exists (Rule 9).
 *   - Amounts are computed here from a server-side subtotal. The browser sends a
 *     subtotal to price; it never sends a total, tax, or split.
 *   - bookings.total_price is NEVER modified. Completion capture validates the
 *     original authorization against it, and raising it would break capture on
 *     every existing booking. Each change order carries its own PaymentIntent.
 */

export const CHANGE_ORDER_STATUS = Object.freeze({
  PENDING_CUSTOMER_APPROVAL: 'pending_customer_approval',
  AUTHORIZED: 'authorized',
  CAPTURED: 'captured',
  DECLINED: 'declined',
  VOIDED: 'voided',
  REFUNDED: 'refunded',
});

/** Counts toward what the customer owes and what the Easer is paid on. */
export const CHANGE_ORDER_BILLABLE_STATUSES = Object.freeze([
  CHANGE_ORDER_STATUS.AUTHORIZED,
  CHANGE_ORDER_STATUS.CAPTURED,
]);

/** Still needs someone to do something. */
export const CHANGE_ORDER_OPEN_STATUSES = Object.freeze([
  CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL,
  CHANGE_ORDER_STATUS.AUTHORIZED,
]);

// A change order may be raised while the job is live — that is the entire point.
// Not on a pending booking (nothing is authorized yet; re-quote instead), and not
// after completion (money is already captured; that is a separate correction).
export const CHANGE_ORDER_ELIGIBLE_STATUSES = Object.freeze([
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.EN_ROUTE,
  BOOKING_STATUS.ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
]);

export const MAX_CHANGE_ORDER_SUBTOTAL_CENTS = 500000; // $5,000 — a sanity ceiling, not a policy
export const MIN_CHANGE_ORDER_SUBTOTAL_CENTS = 100;    // $1.00
export const CHANGE_ORDER_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Price a change order from a subtotal. Tax uses the same canonical rate as the
 * original booking, so a change order is taxed exactly like the work it extends.
 */
export function priceChangeOrder(subtotalCents) {
  const subtotal = Math.round(Number(subtotalCents));
  if (!Number.isFinite(subtotal) || subtotal < MIN_CHANGE_ORDER_SUBTOTAL_CENTS) {
    return { ok: false, error: `Enter an amount of at least $${(MIN_CHANGE_ORDER_SUBTOTAL_CENTS / 100).toFixed(2)}.` };
  }
  if (subtotal > MAX_CHANGE_ORDER_SUBTOTAL_CENTS) {
    return { ok: false, error: `A single change order is capped at $${(MAX_CHANGE_ORDER_SUBTOTAL_CENTS / 100).toFixed(2)}. Split it or rebook the extra work.` };
  }
  const taxCents = Math.round(subtotal * SALES_TAX_RATE);
  return { ok: true, subtotalCents: subtotal, taxCents, totalCents: subtotal + taxCents };
}

/**
 * Can this booking take a change order right now? Returns a reason when not, so
 * the owner is never shown a disabled control with no explanation (Article 16).
 */
export function changeOrderEligibility(booking) {
  if (!booking) return { ok: false, reason: 'Booking not found.' };
  if (!CHANGE_ORDER_ELIGIBLE_STATUSES.includes(booking.status)) {
    if (booking.status === BOOKING_STATUS.PENDING) {
      return { ok: false, reason: 'This booking is not authorized yet — change the quote instead of adding a change order.' };
    }
    if (booking.status === BOOKING_STATUS.COMPLETED) {
      return { ok: false, reason: 'The job is complete and payment is captured. Additional work needs a new booking.' };
    }
    return { ok: false, reason: `A ${booking.status} booking cannot take additional scope.` };
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return { ok: false, reason: 'A payment, cancellation, or payout operation is in progress. Wait for it to finish.' };
  }
  if (booking.stripe_dispute_id) {
    return { ok: false, reason: 'This booking has an open Stripe dispute. Resolve it before charging anything further.' };
  }
  if (booking.payment_method_type === BOOKING_PAYMENT_METHOD.KLARNA) {
    return { ok: false, reason: 'Additional work cannot be added to this Klarna payment. Create a separate card booking for the extra work.' };
  }
  // The charge goes on the card already on file. Without it there is nothing to
  // authorize against and the customer would have to re-enter payment details.
  if (!booking.stripe_customer_id || !booking.stripe_payment_method_id) {
    return { ok: false, reason: 'No saved payment method on this booking, so additional work cannot be authorized. Collect it separately and record it as an offline payment.' };
  }
  return { ok: true };
}

/** Load change orders for one or many bookings, keyed by booking id. */
export async function loadChangeOrders(bookingIds, { sb: injected } = {}) {
  const sb = injected || getSupabase();
  const ids = (Array.isArray(bookingIds) ? bookingIds : [bookingIds]).filter(Boolean);
  if (!ids.length) return new Map();
  const { data, error } = await sb
    .from('booking_change_orders')
    .select('id, booking_id, description, item_name, subtotal_cents, tax_cents, total_cents, status, approved_at, declined_at, decline_reason, stripe_payment_intent_id, authorized_at, captured_at, captured_amount_cents, refunded_cents, approval_expires_at, created_by, created_at')
    .in('booking_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const byBooking = new Map();
  (data || []).forEach(row => {
    if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, []);
    byBooking.get(row.booking_id).push(row);
  });
  return byBooking;
}

/**
 * What the change orders add to a booking. This is the ONE place that decides
 * what "extra" means for the customer total, the tax liability, and the amount
 * the Easer split is calculated on.
 */
export function summarizeChangeOrders(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const billable = list.filter(r => CHANGE_ORDER_BILLABLE_STATUSES.includes(r.status));
  const captured = list.filter(r => r.status === CHANGE_ORDER_STATUS.CAPTURED);
  const pending = list.filter(r => r.status === CHANGE_ORDER_STATUS.PENDING_CUSTOMER_APPROVAL);

  const sum = (arr, key) => arr.reduce((total, r) => total + Number(r[key] || 0), 0);
  const refunded = sum(list, 'refunded_cents');

  return {
    count: list.length,
    // Approved and authorized — what the customer has agreed to pay on top.
    billableSubtotalCents: sum(billable, 'subtotal_cents'),
    billableTaxCents: sum(billable, 'tax_cents'),
    billableTotalCents: sum(billable, 'total_cents'),
    // Actually taken.
    capturedTotalCents: sum(captured, 'captured_amount_cents') || sum(captured, 'total_cents'),
    refundedCents: refunded,
    // Waiting on the customer — money that is NOT yet owed and must never be
    // counted as revenue or paid out on.
    pendingCount: pending.length,
    pendingTotalCents: sum(pending, 'total_cents'),
    openCount: list.filter(r => CHANGE_ORDER_OPEN_STATUSES.includes(r.status)).length,
    rows: list,
  };
}

/**
 * The booking total INCLUDING approved change orders. Use this anywhere the
 * customer's real obligation or the Easer's earnings base is needed — never
 * bookings.total_price alone once change orders exist.
 */
export function effectiveBookingTotals(booking, changeOrderRows) {
  const summary = summarizeChangeOrders(changeOrderRows);
  const baseTotal = Number(booking?.total_price || 0);
  const baseTax = Number(booking?.tax_amount || 0);
  return {
    baseTotalCents: baseTotal,
    baseTaxCents: baseTax,
    changeOrderTotalCents: summary.billableTotalCents,
    changeOrderTaxCents: summary.billableTaxCents,
    effectiveTotalCents: baseTotal + summary.billableTotalCents,
    effectiveTaxCents: baseTax + summary.billableTaxCents,
    summary,
  };
}

export function isBookingActiveForChangeOrders(booking) {
  return ACTIVE_BOOKING_STATUSES.includes(booking?.status);
}
