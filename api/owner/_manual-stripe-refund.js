function objectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function expectedLiveMode(secretKey) {
  const value = String(secretKey || '');
  if (value.startsWith('sk_live_')) return true;
  if (value.startsWith('sk_test_')) return false;
  return null;
}

function truthError(message, code = 'OWNER_MANUAL_STRIPE_REFUND_TRUTH_MISMATCH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function listChargeRefunds(stripe, chargeId) {
  const page = await stripe.refunds.list({ charge: chargeId, limit: 100 });
  if (page?.has_more) {
    throw truthError(
      `Stripe charge ${chargeId} has more than 100 refunds and requires manual reconciliation.`,
      'OWNER_MANUAL_REFUND_PAGINATION_REQUIRED',
    );
  }
  return Array.isArray(page?.data) ? page.data : [];
}

async function retrieveCharge(stripe, intent) {
  const chargeId = objectId(intent?.latest_charge);
  if (!chargeId) return null;
  return typeof intent.latest_charge === 'object'
    ? intent.latest_charge
    : stripe.charges.retrieve(chargeId);
}

export async function loadOwnerManualStripeRefundTruth({
  stripe,
  booking,
  paymentEvents,
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
}) {
  if (!stripe || !booking?.id) throw truthError('Stripe and booking are required.');
  const expectedMode = expectedLiveMode(stripeSecretKey);
  const stripeEvents = (paymentEvents || []).filter(event =>
    ['stripe_manual', 'card_on_site'].includes(String(event.payment_method || '').toLowerCase()));
  if (!stripeEvents.length) {
    throw truthError(
      'This booking has no verified Stripe payment available to refund.',
      'OWNER_MANUAL_STRIPE_PAYMENT_MISSING',
    );
  }

  const rows = [];
  for (const event of stripeEvents) {
    const paymentIntentId = String(event.stripe_payment_intent_id || '');
    const chargeId = String(event.stripe_charge_id || '');
    const amountCents = Number(event.amount_cents);
    const ledgerRefundedCents = Number(event.refunded_cents || 0);
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge'],
    });
    const charge = await retrieveCharge(stripe, intent);
    const chargePaymentIntentId = objectId(charge?.payment_intent);
    const metadataBookingId = String(intent?.metadata?.bookingId || '').trim();

    if (!Number.isInteger(amountCents)
        || amountCents <= 0
        || !Number.isInteger(ledgerRefundedCents)
        || ledgerRefundedCents < 0
        || ledgerRefundedCents > amountCents
        || intent?.id !== paymentIntentId
        || intent?.status !== 'succeeded'
        || intent?.currency !== 'usd'
        || Number(intent?.amount_received) !== amountCents
        || (expectedMode != null && intent?.livemode !== expectedMode)
        || (metadataBookingId && metadataBookingId !== booking.id)
        || !charge
        || charge.id !== chargeId
        || (chargePaymentIntentId && chargePaymentIntentId !== paymentIntentId)
        || charge.status !== 'succeeded'
        || charge.paid !== true
        || charge.captured !== true
        || charge.currency !== 'usd'
        || Number(charge.amount_captured || charge.amount) !== amountCents
        || charge.disputed === true
        || (expectedMode != null && charge.livemode !== expectedMode)) {
      throw truthError(`Stripe payment ${paymentIntentId} no longer matches its verified booking ledger event.`);
    }

    const refunds = await listChargeRefunds(stripe, charge.id);
    const succeededRefunds = refunds.filter(refund => refund.status === 'succeeded');
    const pendingRefunds = refunds.filter(refund =>
      !['succeeded', 'failed', 'canceled'].includes(String(refund.status || '')));
    const failedRefunds = refunds.filter(refund =>
      ['failed', 'canceled'].includes(String(refund.status || '')));
    const stripeRefundedCents = succeededRefunds.reduce(
      (sum, refund) => sum + Number(refund.amount || 0),
      0,
    );
    const pendingRefundCents = pendingRefunds.reduce(
      (sum, refund) => sum + Number(refund.amount || 0),
      0,
    );
    const chargeRefundedCents = Number(charge.amount_refunded || 0);

    if (!Number.isInteger(stripeRefundedCents)
        || !Number.isInteger(pendingRefundCents)
        || !Number.isInteger(chargeRefundedCents)
        || stripeRefundedCents < 0
        || pendingRefundCents < 0
        || chargeRefundedCents < stripeRefundedCents
        || chargeRefundedCents > stripeRefundedCents + pendingRefundCents
        || stripeRefundedCents + pendingRefundCents > amountCents) {
      throw truthError(`Stripe refund totals are invalid for payment ${paymentIntentId}.`);
    }

    rows.push({
      event,
      intent,
      charge,
      refunds,
      succeededRefunds,
      pendingRefunds,
      failedRefunds,
      capturedCents: amountCents,
      ledgerRefundedCents,
      stripeRefundedCents,
      pendingRefundCents,
      remainingRefundableCents: Math.max(
        0,
        amountCents - stripeRefundedCents - pendingRefundCents,
      ),
    });
  }

  const capturedCents = rows.reduce((sum, row) => sum + row.capturedCents, 0);
  const ledgerRefundedCents = rows.reduce((sum, row) => sum + row.ledgerRefundedCents, 0);
  const stripeRefundedCents = rows.reduce((sum, row) => sum + row.stripeRefundedCents, 0);
  const pendingRefundCents = rows.reduce((sum, row) => sum + row.pendingRefundCents, 0);
  return {
    rows,
    capturedCents,
    ledgerRefundedCents,
    stripeRefundedCents,
    pendingRefundCents,
    remainingRefundableCents: Math.max(
      0,
      capturedCents - stripeRefundedCents - pendingRefundCents,
    ),
  };
}

export async function createOwnerManualStripeRefunds({
  stripe,
  booking,
  truth,
  amountCents,
  reason,
}) {
  if (!Number.isInteger(amountCents)
      || amountCents <= 0
      || amountCents > Number(truth?.remainingRefundableCents || 0)) {
    throw truthError(
      'The requested refund exceeds the verified Stripe amount still refundable.',
      'OWNER_MANUAL_REFUND_AMOUNT_INVALID',
    );
  }

  let remainingCents = amountCents;
  const refunds = [];
  const rows = [...truth.rows].sort((a, b) =>
    String(b.event.created_at || '').localeCompare(String(a.event.created_at || '')));

  for (const row of rows) {
    if (remainingCents <= 0) break;
    const allocationCents = Math.min(remainingCents, row.remainingRefundableCents);
    if (allocationCents <= 0) continue;
    const targetEventRefundedCents = row.stripeRefundedCents + allocationCents;
    const attemptNumber = row.failedRefunds.length + 1;
    const refund = await stripe.refunds.create({
      payment_intent: row.intent.id,
      amount: allocationCents,
      reason: 'requested_by_customer',
      metadata: {
        bookingId: booking.id,
        bookingRef: booking.ref || '',
        ownerReason: reason || '',
        ownerManualPayment: 'true',
      },
    }, {
      idempotencyKey: `owner-manual-refund-${booking.id}-${row.intent.id}-total-${targetEventRefundedCents}-attempt-${attemptNumber}`,
    });
    refunds.push({
      paymentEventId: row.event.id,
      paymentIntentId: row.intent.id,
      requestedCents: allocationCents,
      refund,
    });
    remainingCents -= allocationCents;
  }

  if (remainingCents !== 0) {
    throw truthError(
      'Stripe refund allocation did not cover the exact requested amount.',
      'OWNER_MANUAL_REFUND_ALLOCATION_FAILED',
    );
  }
  return refunds;
}
