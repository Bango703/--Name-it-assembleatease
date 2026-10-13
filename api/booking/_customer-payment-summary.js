/**
 * THE price breakdown a customer sees for their booking: a headline total with
 * its label, then rows that add up to it. Built from the fields
 * api/booking/track.js returns; the booking page (track.html) and the customer
 * app both render it and never do the math themselves.
 *
 * All amounts are cents.
 */
const CHARGED = new Set(['captured', 'partially_refunded', 'refunded', 'cancellation_fee_captured']);

export function customerPaymentSummary(b = {}) {
  const ownerManual = b.owner_manual_payment === true;
  const total = Math.max(0, Number(ownerManual
    ? b.total_price
    : (b.amount_charged != null ? b.amount_charged : b.total_price)) || 0);
  const paymentStatus = String(b.payment_status || '');
  const totalLabel = ownerManual
    ? 'Booking Total'
    : CHARGED.has(paymentStatus)
      ? 'Total Charged'
      : (paymentStatus === 'authorized' ? 'Total Authorized' : (paymentStatus === 'deposit_paid' ? 'Deposit Paid' : 'Booking Total'));

  if (total <= 0) return { total_label: totalLabel, total_cents: 0, rows: [], note: null };

  const rawRefunded = Math.max(0, Number(b.refund_amount) || 0);
  const refunded = ownerManual ? rawRefunded : Math.min(total, rawRefunded);
  const tax = Number(b.tax_amount) || 0;
  const call = Number(b.service_call_fee) || 0;
  const rows = [{ label: 'Service & items', cents: Math.max(0, total - tax - call), strong: false }];
  if (call > 0) rows.push({ label: 'Service call fee', cents: call, strong: false });
  if (tax > 0) rows.push({ label: 'Sales tax', cents: tax, strong: false });

  let note = null;
  if (ownerManual) {
    const gross = Math.max(0, Number(b.gross_payment_cents) || 0);
    const net = Math.max(0, Number(b.amount_collected_cents) || 0);
    rows.push({ label: 'Booking total', cents: total, strong: true });
    if (gross > 0) rows.push({ label: 'Payment received (gross)', cents: gross, strong: false });
    if (refunded > 0) rows.push({ label: 'Refunded', cents: -refunded, strong: false });
    if (gross > 0 || refunded > 0) rows.push({ label: 'Net payments retained', cents: net, strong: false });
    rows.push({ label: 'Remaining amount due', cents: Number(b.remaining_balance_cents) || 0, strong: true });
    if (refunded > 0) note = 'The refund shown above does not create a new amount due.';
  } else if (refunded > 0) {
    rows.push({ label: 'Refunded', cents: -refunded, strong: false });
    rows.push({ label: 'Net charged after refund', cents: total - refunded, strong: true });
  }
  return { total_label: totalLabel, total_cents: total, rows, note };
}
