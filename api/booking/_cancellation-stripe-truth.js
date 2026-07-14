export const CANCELLABLE_PAYMENT_INTENT_STATES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'requires_capture',
]);

export function bookingCancellationPaymentIntentIds(booking = {}) {
  return [...new Set([
    booking.stripe_payment_intent_id,
    booking.stripe_deposit_intent_id,
    booking.stripe_balance_payment_intent_id,
  ].filter(Boolean))];
}

function intentCustomerId(intent) {
  return typeof intent?.customer === 'string' ? intent.customer : intent?.customer?.id || null;
}

function cancellationTruthError(message, code = 'CANCELLATION_PAYMENT_INTENT_MISMATCH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateBookingPaymentIntentTopology(booking, { requireIntent = false } = {}) {
  const totalCents = Number(booking?.total_price || 0);
  const depositCents = Number(booking?.deposit_amount || 0);
  const primaryIntentId = booking?.stripe_payment_intent_id || null;
  const explicitDepositIntentId = booking?.stripe_deposit_intent_id || null;
  const balanceIntentId = booking?.stripe_balance_payment_intent_id || null;
  const hasAnyIntent = !!(primaryIntentId || explicitDepositIntentId || balanceIntentId);
  if (requireIntent && !hasAnyIntent) {
    throw cancellationTruthError('Booking has no linked Stripe PaymentIntent.', 'CANCELLATION_PAYMENT_INTENT_MISSING');
  }
  if (!hasAnyIntent) {
    return { flow: 'none', totalCents, depositCents: 0, balanceCents: 0, expectedByIntentId: new Map() };
  }
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw cancellationTruthError('The linked Stripe payment has no valid server-priced booking total.');
  }

  const depositFlow = booking?.is_deposit === true
    || depositCents > 0
    || !!explicitDepositIntentId
    || !!balanceIntentId;
  if (!depositFlow) {
    if (!primaryIntentId || explicitDepositIntentId || balanceIntentId) {
      throw cancellationTruthError('Stripe PaymentIntent topology does not match a full-payment booking.');
    }
    return {
      flow: 'full',
      totalCents,
      depositCents: 0,
      balanceCents: 0,
      expectedByIntentId: new Map([[primaryIntentId, {
        role: 'primary',
        expectedAmountCents: totalCents,
        allowedTypes: new Set(['customer_booking', 'customer_quote', 'reauth']),
      }]]),
    };
  }

  if (!Number.isInteger(depositCents) || depositCents <= 0 || depositCents > totalCents) {
    throw cancellationTruthError('Deposit payment topology has an invalid server deposit amount.');
  }
  if (primaryIntentId && explicitDepositIntentId && primaryIntentId !== explicitDepositIntentId) {
    throw cancellationTruthError('A booking cannot link a distinct full primary payment and deposit payment.');
  }
  const depositIntentId = explicitDepositIntentId || primaryIntentId;
  if (!depositIntentId) {
    throw cancellationTruthError('A balance payment cannot exist without its linked deposit payment.');
  }
  const balanceCents = totalCents - depositCents;
  if (balanceIntentId === depositIntentId) {
    throw cancellationTruthError('Deposit and balance must use distinct Stripe PaymentIntents.');
  }
  if (balanceIntentId && balanceCents <= 0) {
    throw cancellationTruthError('A fully paid deposit booking cannot also link a balance PaymentIntent.');
  }
  if (balanceCents > 0
      && !balanceIntentId
      && ['captured', 'refund_pending', 'partially_refunded', 'refunded'].includes(String(booking.payment_status || ''))) {
    throw cancellationTruthError('Captured deposit payment topology is missing its balance PaymentIntent.');
  }

  const expectedByIntentId = new Map([[depositIntentId, {
    role: 'deposit',
    expectedAmountCents: depositCents,
    allowedTypes: new Set(['customer_booking', 'customer_quote', 'customer_booking_deposit']),
  }]]);
  if (balanceIntentId) {
    expectedByIntentId.set(balanceIntentId, {
      role: 'balance',
      expectedAmountCents: balanceCents,
      allowedTypes: new Set(['customer_booking_balance']),
    });
  }
  return { flow: 'deposit_balance', totalCents, depositCents, balanceCents, expectedByIntentId };
}

export function validateBookingCapturedAggregate(booking, topology, rows) {
  const capturedCents = rows.reduce((total, row) => total + row.capturedCents, 0);
  if (!Number.isInteger(capturedCents) || capturedCents < 0 || capturedCents > topology.totalCents) {
    throw cancellationTruthError('Aggregate Stripe capture exceeds server-priced booking truth.', 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED');
  }

  const paymentStatus = String(booking.payment_status || '');
  const amountChargedCents = Number(booking.amount_charged || 0);
  if (['captured', 'refund_pending', 'partially_refunded', 'refunded'].includes(paymentStatus)) {
    if (!Number.isInteger(amountChargedCents)
        || amountChargedCents <= 0
        || capturedCents !== amountChargedCents) {
      throw cancellationTruthError('Aggregate Stripe capture does not match the booking amount charged.', 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED');
    }
  }
  if (paymentStatus === 'deposit_paid') {
    if (topology.flow !== 'deposit_balance'
        || capturedCents !== topology.depositCents
        || (amountChargedCents > 0 && amountChargedCents !== topology.depositCents)) {
      throw cancellationTruthError('Stripe deposit capture does not match booking deposit truth.', 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED');
    }
  }
  if (paymentStatus === 'cancellation_fee_captured') {
    const feeCents = Number(booking.cancellation_fee || booking.amount_charged || 0);
    if (topology.flow !== 'full' || !Number.isInteger(feeCents) || feeCents <= 0 || capturedCents !== feeCents) {
      throw cancellationTruthError('Stripe cancellation fee capture does not match booking truth.', 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED');
    }
  }
  return capturedCents;
}

export async function loadBookingCancellationPaymentIntents(stripe, booking, {
  errorCode = 'CANCELLATION_PAYMENT_INTENT_MISMATCH',
} = {}) {
  const topology = validateBookingPaymentIntentTopology(booking, { requireIntent: true });
  const rows = [];
  for (const paymentIntentId of bookingCancellationPaymentIntentIds(booking)) {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const expected = topology.expectedByIntentId.get(paymentIntentId);
    const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
      ? true
      : (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? false : null);
    if (!intent
        || intent.id !== paymentIntentId
        || intent.metadata?.bookingId !== booking.id
        || intent.currency !== 'usd'
        || !expected
        || !expected.allowedTypes.has(intent.metadata?.type)
        || !Number.isInteger(expected.expectedAmountCents)
        || expected.expectedAmountCents <= 0
        || Number(intent.amount || 0) !== expected.expectedAmountCents
        || (booking.stripe_customer_id && intentCustomerId(intent) !== booking.stripe_customer_id)
        || (expectedLiveMode != null && intent.livemode !== expectedLiveMode)) {
      const error = new Error(`Stripe PaymentIntent ${paymentIntentId} does not match current server-priced booking truth.`);
      error.code = errorCode;
      throw error;
    }

    let charge = null;
    let capturedCents = 0;
    let refunds = [];
    if (intent.status === 'succeeded') {
      const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge?.id;
      if (!chargeId) {
        throw cancellationTruthError(`Captured PaymentIntent ${paymentIntentId} has no verifiable Stripe charge.`, errorCode);
      }
      charge = await stripe.charges.retrieve(chargeId);
      capturedCents = Number(charge?.amount_captured ?? intent.amount_received ?? 0);
      if (!charge
          || charge.id !== chargeId
          || (typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id) !== paymentIntentId
          || charge.currency !== 'usd'
          || charge.captured !== true
          || charge.paid !== true
          || charge.disputed === true
          || Number(intent.amount_received || 0) !== capturedCents
          || !Number.isInteger(capturedCents)
          || capturedCents <= 0
          || capturedCents > expected.expectedAmountCents
          || (booking.stripe_customer_id && intentCustomerId(charge) !== booking.stripe_customer_id)
          || (expectedLiveMode != null && charge.livemode !== expectedLiveMode)) {
        throw cancellationTruthError(`Stripe charge ${chargeId} does not match captured booking truth.`, errorCode);
      }

      const refundPage = await stripe.refunds.list({ charge: chargeId, limit: 100 });
      if (refundPage?.has_more) {
        const error = new Error(`Stripe refunds for PaymentIntent ${paymentIntentId} require pagination reconciliation.`);
        error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
        throw error;
      }
      refunds = Array.isArray(refundPage?.data) ? refundPage.data : [];
      if (refunds.some(refund => refund.charge
        && (typeof refund.charge === 'string' ? refund.charge : refund.charge?.id) !== chargeId)) {
        throw cancellationTruthError(`Stripe refund linkage does not match charge ${chargeId}.`);
      }
    }
    const succeededRefundCents = refunds
      .filter(refund => refund.status === 'succeeded')
      .reduce((total, refund) => total + Number(refund.amount || 0), 0);
    const pendingRefundCents = refunds
      .filter(refund => !['succeeded', 'failed', 'canceled'].includes(String(refund.status || '')))
      .reduce((total, refund) => total + Number(refund.amount || 0), 0);
    const chargeRefundedCents = Number(charge?.amount_refunded || 0);
    if (!Number.isInteger(succeededRefundCents)
        || !Number.isInteger(pendingRefundCents)
        || !Number.isInteger(chargeRefundedCents)
        || succeededRefundCents < 0
        || pendingRefundCents < 0
        || chargeRefundedCents < succeededRefundCents
        || chargeRefundedCents > succeededRefundCents + pendingRefundCents
        || succeededRefundCents + pendingRefundCents > capturedCents
        || (charge?.refunded === true) !== (capturedCents > 0 && chargeRefundedCents === capturedCents)) {
      const error = new Error(`Stripe refund totals for PaymentIntent ${paymentIntentId} are inconsistent.`);
      error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
      throw error;
    }
    rows.push({
      paymentIntentId,
      intent,
      charge,
      role: expected.role,
      isBalance: expected.role === 'balance',
      isDeposit: expected.role === 'deposit',
      expectedAmountCents: expected.expectedAmountCents,
      capturedCents,
      refunds,
      succeededRefundCents,
      pendingRefundCents,
      chargeRefundedCents,
    });
  }
  validateBookingCapturedAggregate(booking, topology, rows);
  return rows;
}

export function isUnrefundedCancellationFeeCapture(row, booking, expectedFeeCents) {
  return !!row
    && !row.isBalance
    && !row.isDeposit
    && row.intent.status === 'succeeded'
    && row.intent.capture_method === 'manual'
    && Number(row.intent.amount || 0) === Number(booking.total_price || 0)
    && Number(row.intent.amount_received || 0) === Number(expectedFeeCents || 0)
    && Number(expectedFeeCents || 0) > 0
    && row.succeededRefundCents === 0
    && row.pendingRefundCents === 0
    && row.chargeRefundedCents === 0
    && !!row.charge?.id
    && row.charge.disputed !== true;
}
