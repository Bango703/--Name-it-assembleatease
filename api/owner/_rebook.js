const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SETTLED_STRIPE_CANCELLATION_STATUSES = new Set([
  'authorization_released',
  'cancellation_fee_captured',
  'refunded',
]);

export function normalizeRebookSourceId(value) {
  const id = String(value || '').trim();
  return UUID_RE.test(id) ? id : null;
}

export function validateOwnerRebookSource(booking = {}) {
  if (!booking.id || String(booking.status || '').toLowerCase() !== 'cancelled') {
    return {
      ok: false,
      code: 'REBOOK_CANCELLED_SOURCE_REQUIRED',
      error: 'Only a cancelled booking can be used to create a rebooking.',
    };
  }

  if (booking.financial_operation_key
      || booking.financial_reconciliation_required_at
      || booking.cancellation_reconciliation_required_at) {
    return {
      ok: false,
      code: 'REBOOK_SOURCE_RECONCILIATION_REQUIRED',
      error: 'Finish the cancelled booking payment reconciliation before creating a rebooking.',
    };
  }

  const hasLinkedStripePayment = Boolean(
    booking.stripe_payment_intent_id
      || booking.stripe_deposit_intent_id
      || booking.stripe_balance_payment_intent_id,
  );
  const paymentStatus = String(booking.payment_status || '').toLowerCase();
  if (hasLinkedStripePayment && !SETTLED_STRIPE_CANCELLATION_STATUSES.has(paymentStatus)) {
    return {
      ok: false,
      code: 'REBOOK_SOURCE_PAYMENT_UNSETTLED',
      error: 'The cancelled booking still has unsettled Stripe payment activity. Reconcile it before rebooking.',
    };
  }

  const isOwnerManual = ['owner_manual', 'manual'].includes(String(booking.source || '').toLowerCase());
  const amountCollected = Math.max(0, Number(booking.amount_charged || 0));
  const amountRefunded = Math.max(0, Number(booking.refund_amount || 0));
  if (isOwnerManual
      && booking.payment_collected === true
      && paymentStatus !== 'cancellation_fee_captured'
      && amountCollected > amountRefunded) {
    return {
      ok: false,
      code: 'REBOOK_SOURCE_OFFLINE_PAYMENT_UNSETTLED',
      error: 'Reconcile or refund the original owner-booking payment before creating a rebooking.',
    };
  }

  return { ok: true };
}
