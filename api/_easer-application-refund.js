import {
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_CURRENCY,
  validateEaserApplicationPaymentIntent,
} from './_easer-application-fee.js';

const REFUND_PENDING_STATUSES = new Set(['pending', 'requires_action']);
const REFUND_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const REFUND_STATUSES = new Set([...REFUND_PENDING_STATUSES, ...REFUND_TERMINAL_STATUSES]);
const DISPUTE_STATUSES = new Set([
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
]);
const RESOLVED_DISPUTE_STATUSES = new Set(['won', 'warning_closed', 'prevented']);

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function validStripeTimestamp(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

/**
 * Load one complete, fresh Stripe view of the fixed Easer application fee.
 * The caller must never aggregate an event object's embedded refund list: it
 * can be stale or truncated. Any unprovable Stripe shape fails closed.
 */
export async function loadEaserApplicationFeeRefundTruth({
  stripe,
  assemblerId,
  paymentIntentId,
  customerId,
  expectedChargeId = null,
} = {}) {
  if (!stripe || !assemblerId || !paymentIntentId || !customerId) {
    throw new Error('Complete application-fee Stripe identifiers are required');
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  validateEaserApplicationPaymentIntent(paymentIntent, {
    userId: assemblerId,
    paymentIntentId,
    customerId,
    requireSucceeded: true,
    requireConsent: true,
  });
  if (typeof paymentIntent.livemode !== 'boolean') {
    throw new Error('Stripe application-fee mode could not be verified');
  }

  const chargeId = stripeId(paymentIntent.latest_charge);
  if (!chargeId || (expectedChargeId && chargeId !== expectedChargeId)) {
    throw new Error('Stripe application-fee charge does not match the refund event');
  }
  const charge = await stripe.charges.retrieve(chargeId);
  const chargePaymentIntentId = stripeId(charge?.payment_intent);
  const chargeCustomerId = stripeId(charge?.customer);
  if (charge?.id !== chargeId
      || chargePaymentIntentId !== paymentIntentId
      || chargeCustomerId !== customerId
      || charge.currency !== EASER_APPLICATION_FEE_CURRENCY
      || Number(charge.amount || 0) !== EASER_APPLICATION_FEE_CENTS
      || Number(charge.amount_captured || 0) !== EASER_APPLICATION_FEE_CENTS
      || charge.paid !== true
      || charge.status !== 'succeeded'
      || charge.livemode !== paymentIntent.livemode) {
    throw new Error('Stripe application-fee charge truth is inconsistent');
  }

  const listed = await stripe.refunds.list({
    payment_intent: paymentIntentId,
    limit: 100,
  });
  if (listed?.has_more === true) {
    throw new Error('Stripe application-fee refund history is truncated');
  }
  if (!Array.isArray(listed?.data)) {
    throw new Error('Stripe application-fee refund history is unavailable');
  }

  let succeededRefundedCents = 0;
  let pendingRefundCents = 0;
  let latestSucceededRefund = null;
  for (const refund of listed.data) {
    const status = String(refund?.status || '').trim().toLowerCase();
    const amount = Number(refund?.amount);
    if (!refund?.id
        || !REFUND_STATUSES.has(status)
        || stripeId(refund.payment_intent) !== paymentIntentId
        || stripeId(refund.charge) !== chargeId
        || refund.currency !== EASER_APPLICATION_FEE_CURRENCY
        || refund.livemode !== paymentIntent.livemode
        || !Number.isInteger(amount)
        || amount <= 0
        || amount > EASER_APPLICATION_FEE_CENTS
        || !validStripeTimestamp(refund.created)) {
      throw new Error('Stripe application-fee refund truth is inconsistent');
    }
    if (status === 'succeeded') {
      succeededRefundedCents += amount;
      if (!latestSucceededRefund
          || Number(refund.created) > Number(latestSucceededRefund.created)
          || (Number(refund.created) === Number(latestSucceededRefund.created)
            && String(refund.id) > String(latestSucceededRefund.id))) {
        latestSucceededRefund = refund;
      }
    } else if (REFUND_PENDING_STATUSES.has(status)) {
      pendingRefundCents += amount;
    }
  }

  if (succeededRefundedCents > EASER_APPLICATION_FEE_CENTS
      || pendingRefundCents > EASER_APPLICATION_FEE_CENTS
      || succeededRefundedCents + pendingRefundCents > EASER_APPLICATION_FEE_CENTS) {
    throw new Error('Stripe application-fee refunds exceed the canonical fee');
  }
  if ((succeededRefundedCents > 0) !== Boolean(latestSucceededRefund)) {
    throw new Error('Stripe application-fee succeeded refund summary is inconsistent');
  }

  return {
    paymentIntent,
    charge,
    refunds: listed.data,
    succeededRefundedCents,
    pendingRefundCents,
    remainingRefundableCents: EASER_APPLICATION_FEE_CENTS - succeededRefundedCents,
    latestSucceededRefundId: latestSucceededRefund?.id || null,
    latestSucceededRefundedAt: latestSucceededRefund
      ? new Date(Number(latestSucceededRefund.created) * 1000).toISOString()
      : null,
    hasRefundActivity: listed.data.length > 0,
    hasLiveRefundActivity: succeededRefundedCents > 0 || pendingRefundCents > 0,
    fullyRefunded: succeededRefundedCents === EASER_APPLICATION_FEE_CENTS,
  };
}

export async function loadEaserApplicationFeeDisputeTruth({
  stripe,
  paymentTruth,
  expectedDisputeId = null,
} = {}) {
  if (!stripe || !paymentTruth?.charge?.id || !paymentTruth?.paymentIntent?.id) {
    throw new Error('Fresh application-fee payment truth is required for dispute verification');
  }
  const listed = await stripe.disputes.list({
    charge: paymentTruth.charge.id,
    limit: 100,
  });
  if (listed?.has_more === true) {
    throw new Error('Stripe application-fee dispute history is truncated');
  }
  if (!Array.isArray(listed?.data)) {
    throw new Error('Stripe application-fee dispute history is unavailable');
  }

  let expectedFound = !expectedDisputeId;
  for (const dispute of listed.data) {
    const status = String(dispute?.status || '').trim().toLowerCase();
    const amount = Number(dispute?.amount);
    if (!dispute?.id
        || !DISPUTE_STATUSES.has(status)
        || stripeId(dispute.charge) !== paymentTruth.charge.id
        || dispute.currency !== EASER_APPLICATION_FEE_CURRENCY
        || dispute.livemode !== paymentTruth.paymentIntent.livemode
        || !Number.isInteger(amount)
        || amount <= 0
        || amount > EASER_APPLICATION_FEE_CENTS
        || !validStripeTimestamp(dispute.created)) {
      throw new Error('Stripe application-fee dispute truth is inconsistent');
    }
    if (dispute.id === expectedDisputeId) expectedFound = true;
  }
  if (!expectedFound) {
    throw new Error('Stripe application-fee dispute event is missing from fresh Stripe truth');
  }

  const blockingDisputes = listed.data.filter(dispute => (
    !RESOLVED_DISPUTE_STATUSES.has(String(dispute.status || '').trim().toLowerCase())
  ));
  const latestDispute = [...listed.data].sort((a, b) => (
    Number(b.created || 0) - Number(a.created || 0) || String(b.id).localeCompare(String(a.id))
  ))[0] || null;
  return {
    disputes: listed.data,
    blockingDisputes,
    hasDisputeActivity: listed.data.length > 0,
    hasBlockingDispute: blockingDisputes.length > 0,
    latestDispute,
  };
}

export async function holdEaserApplicationFeeRefund(sb, {
  assemblerId,
  paymentIntentId,
  observedAt = new Date().toISOString(),
  reason = 'Stripe application-fee refund activity requires review',
} = {}) {
  const { data, error } = await sb.rpc('hold_easer_application_fee_refund', {
    p_assembler_id: assemblerId,
    p_payment_intent_id: paymentIntentId,
    p_observed_at: observedAt,
    p_reason: reason,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.result_action) throw new Error('Application-fee refund hold returned no authoritative result');
  return result;
}

export async function reconcileEaserApplicationFeeRefund(sb, {
  assemblerId,
  paymentIntentId,
  customerId,
  truth,
  observedAt = new Date().toISOString(),
  reason = 'Stripe application-fee refund activity requires review',
} = {}) {
  if (!truth) throw new Error('Fresh Stripe application-fee refund truth is required');
  const { data, error } = await sb.rpc('reconcile_easer_application_fee_refund', {
    p_assembler_id: assemblerId,
    p_payment_intent_id: paymentIntentId,
    p_stripe_customer_id: customerId,
    p_succeeded_refunded_cents: truth.succeededRefundedCents,
    p_pending_refund_cents: truth.pendingRefundCents,
    p_latest_succeeded_refund_id: truth.latestSucceededRefundId,
    p_latest_succeeded_refunded_at: truth.latestSucceededRefundedAt,
    p_observed_at: observedAt,
    p_reason: reason,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.result_action) throw new Error('Application-fee refund reconciliation returned no authoritative result');
  return result;
}
