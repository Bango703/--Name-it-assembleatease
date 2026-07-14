import {
  validateBookingCapturedAggregate,
  validateBookingPaymentIntentTopology,
} from './_cancellation-stripe-truth.js';

function paymentTruthError(message, code = 'STRIPE_REFUND_TRUTH_MISMATCH') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function bookingPaymentIntentIds(booking = {}) {
  return [...new Set([
    booking.stripe_payment_intent_id,
    booking.stripe_deposit_intent_id,
    booking.stripe_balance_payment_intent_id,
  ].filter(Boolean))];
}

async function retrieveCharge(stripe, intent) {
  if (!intent?.latest_charge) return null;
  const chargeId = typeof intent.latest_charge === 'string' ? intent.latest_charge : intent.latest_charge.id;
  return chargeId ? stripe.charges.retrieve(chargeId) : null;
}

function stripeCustomerId(value) {
  return typeof value?.customer === 'string' ? value.customer : value?.customer?.id || null;
}

async function listChargeRefunds(stripe, charge) {
  if (!charge?.id) return [];
  const page = await stripe.refunds.list({ charge: charge.id, limit: 100 });
  if (page?.has_more) {
    throw paymentTruthError(
      `Stripe charge ${charge.id} has more than 100 refunds and requires manual reconciliation`,
      'STRIPE_REFUND_PAGINATION_REQUIRED',
    );
  }
  return Array.isArray(page?.data) ? page.data : [];
}

export async function loadBookingStripeRefundTruth({ stripe, booking }) {
  if (!stripe || !booking?.id) throw paymentTruthError('Stripe and booking are required');
  const intentIds = bookingPaymentIntentIds(booking);
  if (!intentIds.length) throw paymentTruthError('Booking has no linked Stripe PaymentIntent', 'STRIPE_PAYMENT_INTENT_MISSING');
  const topology = validateBookingPaymentIntentTopology(booking, { requireIntent: true });
  const expectedLiveMode = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
    ? true
    : (String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? false : null);

  const rows = [];
  for (const paymentIntentId of intentIds) {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
    const expected = topology.expectedByIntentId.get(paymentIntentId);
    if (intent.id !== paymentIntentId
        || intent.metadata?.bookingId !== booking.id
        || intent.currency !== 'usd'
        || !expected
        || !expected.allowedTypes.has(intent.metadata?.type)
        || Number(intent.amount || 0) !== expected.expectedAmountCents
        || (booking.stripe_customer_id && stripeCustomerId(intent) !== booking.stripe_customer_id)
        || (expectedLiveMode != null && intent.livemode !== expectedLiveMode)) {
      throw paymentTruthError(`Stripe PaymentIntent ${paymentIntentId} does not match booking truth`);
    }

    const charge = await retrieveCharge(stripe, intent);
    const capturedCents = intent.status === 'succeeded'
      ? Number(charge?.amount_captured ?? intent.amount_received ?? 0)
      : 0;
    if (intent.status === 'succeeded'
        && (!charge?.id
          || (typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id) !== paymentIntentId
          || charge.currency !== 'usd'
          || charge.captured !== true
          || charge.paid !== true
          || charge.disputed === true
          || Number(intent.amount_received || 0) !== capturedCents
          || capturedCents <= 0
          || capturedCents > expected.expectedAmountCents
          || (booking.stripe_customer_id && stripeCustomerId(charge) !== booking.stripe_customer_id)
          || (expectedLiveMode != null && charge.livemode !== expectedLiveMode))) {
      throw paymentTruthError(`Stripe charge does not match captured truth for ${paymentIntentId}`);
    }
    const refunds = charge ? await listChargeRefunds(stripe, charge) : [];
    const succeededRefunds = refunds.filter(refund => refund.status === 'succeeded');
    const pendingRefunds = refunds.filter(refund => !['succeeded', 'failed', 'canceled'].includes(String(refund.status || '')));
    const failedRefunds = refunds.filter(refund => ['failed', 'canceled'].includes(String(refund.status || '')));
    const refundedCents = succeededRefunds.reduce((total, refund) => total + Number(refund.amount || 0), 0);
    const pendingRefundCents = pendingRefunds.reduce((total, refund) => total + Number(refund.amount || 0), 0);
    const stripeChargeRefundedCents = Number(charge?.amount_refunded || 0);
    if (!Number.isInteger(capturedCents)
        || !Number.isInteger(refundedCents)
        || !Number.isInteger(pendingRefundCents)
        || !Number.isInteger(stripeChargeRefundedCents)
        || capturedCents < 0
        || refundedCents < 0
        || pendingRefundCents < 0
        || stripeChargeRefundedCents < refundedCents
        || stripeChargeRefundedCents > refundedCents + pendingRefundCents
        || refundedCents + pendingRefundCents > capturedCents) {
      throw paymentTruthError(`Stripe charge totals are invalid for ${paymentIntentId}`);
    }
    if (intent.status === 'succeeded' && capturedCents > 0 && !charge?.id) {
      throw paymentTruthError(`Captured PaymentIntent ${paymentIntentId} has no verifiable charge`);
    }

    rows.push({
      paymentIntentId,
      intent,
      charge,
      role: expected.role,
      expectedAmountCents: expected.expectedAmountCents,
      refunds,
      succeededRefunds,
      pendingRefunds,
      failedRefunds,
      capturedCents,
      refundedCents,
      pendingRefundCents,
      remainingRefundableCents: Math.max(0, capturedCents - refundedCents - pendingRefundCents),
    });
  }

  const capturedCents = rows.reduce((total, row) => total + row.capturedCents, 0);
  validateBookingCapturedAggregate(booking, topology, rows);
  const refundedCents = rows.reduce((total, row) => total + row.refundedCents, 0);
  const pendingRefundCents = rows.reduce((total, row) => total + row.pendingRefundCents, 0);
  return {
    rows,
    capturedCents,
    refundedCents,
    pendingRefundCents,
    remainingRefundableCents: Math.max(0, capturedCents - refundedCents - pendingRefundCents),
    fullyRefunded: capturedCents > 0 && refundedCents >= capturedCents,
    fullyAllocated: capturedCents > 0 && refundedCents + pendingRefundCents >= capturedCents,
  };
}

export async function refundAllRemainingBookingCharges({ stripe, booking, reason, keyPrefix }) {
  const before = await loadBookingStripeRefundTruth({ stripe, booking });
  const refunds = [];
  for (const row of before.rows) {
    if (row.remainingRefundableCents <= 0) continue;
    const targetCents = row.refundedCents + row.remainingRefundableCents;
    const attemptNumber = row.failedRefunds.length + 1;
    try {
      const refund = await stripe.refunds.create({
        payment_intent: row.paymentIntentId,
        amount: row.remainingRefundableCents,
        reason: 'requested_by_customer',
        metadata: {
          bookingId: booking.id,
          bookingRef: booking.ref || '',
          ownerReason: reason || '',
          aggregateRefund: 'true',
        },
      }, {
        idempotencyKey: `${keyPrefix || 'booking-refund'}-${booking.id}-${row.paymentIntentId}-total-${targetCents}-attempt-${attemptNumber}`,
      });
      refunds.push({ paymentIntentId: row.paymentIntentId, requestedCents: row.remainingRefundableCents, refund });
    } catch (error) {
      const afterError = await loadBookingStripeRefundTruth({ stripe, booking });
      return { before, after: afterError, refunds, error };
    }
  }

  const after = await loadBookingStripeRefundTruth({ stripe, booking });
  return { before, after, refunds, error: null };
}

export function refundPaymentStatus(truth) {
  if (!truth || truth.refundedCents <= 0) return null;
  return truth.fullyRefunded ? 'refunded' : 'partially_refunded';
}
