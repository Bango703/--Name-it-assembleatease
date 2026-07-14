const DISPUTE_STATUSES = new Set([
  'warning_needs_response', 'warning_under_review', 'warning_closed',
  'needs_response', 'under_review', 'won', 'lost', 'prevented',
]);
const CHARGE_STATUSES = new Set(['succeeded', 'pending', 'failed']);

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

export async function loadBookingStripeDisputeTruth({ stripe, booking } = {}) {
  const paymentIntentIds = [...new Set([
    booking?.stripe_payment_intent_id,
    booking?.stripe_deposit_intent_id,
    booking?.stripe_balance_payment_intent_id,
  ].filter(Boolean))];
  if (!stripe || !booking?.id || !paymentIntentIds.length) {
    throw new Error('Booking dispute verification requires exact Stripe PaymentIntents');
  }

  const payments = [];
  const disputeById = new Map();
  for (const paymentIntentId of paymentIntentIds) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const customerId = stripeId(paymentIntent?.customer);
    if (paymentIntent?.id !== paymentIntentId
        || paymentIntent.metadata?.bookingId !== booking.id
        || paymentIntent.currency !== 'usd'
        || typeof paymentIntent.livemode !== 'boolean'
        || (booking.stripe_customer_id && customerId !== booking.stripe_customer_id)) {
      throw new Error('Booking dispute PaymentIntent truth is inconsistent');
    }

    const chargeList = await stripe.charges.list({ payment_intent: paymentIntentId, limit: 100 });
    if (chargeList?.has_more === true || !Array.isArray(chargeList?.data)) {
      throw new Error('Booking dispute charge history is truncated or unavailable');
    }
    for (const charge of chargeList.data) {
      const status = String(charge?.status || '').toLowerCase();
      const amount = Number(charge?.amount);
      if (!charge?.id
          || stripeId(charge.payment_intent) !== paymentIntentId
          || stripeId(charge.customer) !== customerId
          || charge.currency !== 'usd'
          || charge.livemode !== paymentIntent.livemode
          || !CHARGE_STATUSES.has(status)
          || !Number.isInteger(amount)
          || amount <= 0) {
        throw new Error('Booking dispute charge truth is inconsistent');
      }
      const disputeList = await stripe.disputes.list({ charge: charge.id, limit: 100 });
      if (disputeList?.has_more === true || !Array.isArray(disputeList?.data)) {
        throw new Error('Booking dispute history is truncated or unavailable');
      }
      for (const dispute of disputeList.data) {
        const disputeStatus = String(dispute?.status || '').toLowerCase();
        const disputeAmount = Number(dispute?.amount);
        if (!dispute?.id
            || stripeId(dispute.charge) !== charge.id
            || !DISPUTE_STATUSES.has(disputeStatus)
            || dispute.currency !== 'usd'
            || dispute.livemode !== charge.livemode
            || !Number.isInteger(disputeAmount)
            || disputeAmount <= 0
            || disputeAmount > amount) {
          throw new Error('Booking dispute aggregate contains inconsistent truth');
        }
        const prior = disputeById.get(dispute.id);
        if (prior && (prior.charge.id !== charge.id || prior.paymentIntent.id !== paymentIntentId)) {
          throw new Error('Stripe dispute is linked to multiple booking charges');
        }
        disputeById.set(dispute.id, { dispute, charge, paymentIntent });
      }
    }
    payments.push({ paymentIntent, charges: chargeList.data });
  }

  return {
    payments,
    disputes: [...disputeById.values()],
  };
}
