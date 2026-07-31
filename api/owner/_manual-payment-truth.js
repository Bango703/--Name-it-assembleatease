import Stripe from 'stripe';
import { normalizeOwnerOfflinePaymentMethod } from './_offline-payment.js';

function objectId(value) {
  return typeof value === 'string' ? value : value?.id || null;
}

function expectedLiveMode(secretKey) {
  const value = String(secretKey || '');
  if (value.startsWith('sk_live_')) return true;
  if (value.startsWith('sk_test_')) return false;
  return null;
}

export function manualStripeEventMatches(event, intent, keyLiveMode) {
  const charge = intent?.latest_charge;
  const chargePaymentIntentId = objectId(charge?.payment_intent);
  const amountCents = Number(event?.amount_cents);
  const refundedCents = Number(event?.refunded_cents || 0);
  return !!(
    event
    && intent
    && intent.id === event.stripe_payment_intent_id
    && intent.status === 'succeeded'
    && intent.currency === 'usd'
    && Number(intent.amount_received) === amountCents
    && (keyLiveMode == null || intent.livemode === keyLiveMode)
    && charge
    && typeof charge === 'object'
    && objectId(charge) === event.stripe_charge_id
    && charge.status === 'succeeded'
    && charge.paid === true
    && charge.captured === true
    && charge.currency === 'usd'
    && (keyLiveMode == null || charge.livemode === keyLiveMode)
    && (!chargePaymentIntentId || chargePaymentIntentId === intent.id)
    && Number(charge.amount_captured || charge.amount) === amountCents
    && Number(charge.amount_refunded || 0) === refundedCents
    && charge.refunded === (refundedCents === amountCents)
    && charge.disputed !== true
  );
}

export async function verifyOwnerManualCustomerFundsForPayout({
  sb,
  booking,
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient = null,
  allowRefundedOriginalPayment = false,
}) {
  const { data: events, error } = await sb
    .from('owner_manual_payment_events')
    .select('amount_cents, refunded_cents, payment_method, stripe_payment_intent_id, stripe_charge_id')
    .eq('booking_id', booking.id)
    .order('created_at', { ascending: true });

  if (error) {
    return {
      ok: false,
      code: 'OWNER_MANUAL_PAYMENT_LEDGER_UNAVAILABLE',
      error: 'Customer payment history is unavailable. Do not pay or credit the Easer until migrations through 047 and the payment ledger are verified.',
    };
  }

  if (!events?.length) {
    const method = normalizeOwnerOfflinePaymentMethod(booking.payment_method);
    if (['stripe_manual', 'card_on_site', 'mixed'].includes(method)) {
      return {
        ok: false,
        code: 'LEGACY_STRIPE_PAYMENT_RECONCILIATION_REQUIRED',
        error: 'This manual Stripe collection predates the verified payment ledger. Reconcile it before paying the Easer.',
      };
    }
    const chargedCents = Number(booking.amount_charged ?? booking.total_price ?? 0);
    if (!method
        || booking.payment_collected !== true
        || !booking.payment_collected_at
        || !String(booking.payment_collected_by || '').trim()
        || chargedCents !== Number(booking.total_price || 0)
        || chargedCents <= 0) {
      return {
        ok: false,
        code: 'OWNER_MANUAL_PAYMENT_BALANCE_REMAINS',
        error: 'The audited non-Stripe payment record is incomplete. Reconcile it before paying or crediting the Easer.',
      };
    }
    return { ok: true, legacyNonStripe: true, collectedCents: chargedCents };
  }

  const grossCollectedCents = events.reduce(
    (sum, event) => sum + Number(event.amount_cents || 0),
    0,
  );
  const refundedCents = events.reduce(
    (sum, event) => sum + Number(event.refunded_cents || 0),
    0,
  );
  const collectedCents = grossCollectedCents - refundedCents;
  const totalCents = Number(booking.total_price || 0);
  const refundAffected = refundedCents > 0;
  const originalPaymentSatisfied = grossCollectedCents === totalCents;
  const refundLedgerMatchesBooking = Number(booking.refund_amount || 0) === refundedCents;
  if (refundAffected && allowRefundedOriginalPayment) {
    if (!originalPaymentSatisfied || !refundLedgerMatchesBooking) {
      return {
        ok: false,
        code: 'OWNER_MANUAL_REFUND_RECONCILIATION_REQUIRED',
        error: 'The original customer payment or refund ledger does not match the booking total. Reconcile it before crediting or paying the Easer.',
      };
    }
  } else if (booking.payment_collected !== true || collectedCents !== totalCents) {
    return {
      ok: false,
      code: 'OWNER_MANUAL_PAYMENT_BALANCE_REMAINS',
      error: refundAffected
        ? 'This booking has a customer refund. Complete the Easer earnings review before payout; do not charge the customer again.'
        : 'The verified customer payments do not equal the booking total. Collect and record the remaining balance before paying the Easer.',
    };
  }

  const stripeEvents = events.filter(event => ['stripe_manual', 'card_on_site'].includes(event.payment_method));
  if (!stripeEvents.length) return {
    ok: true,
    collectedCents,
    grossCollectedCents,
    refundedCents,
    stripeEventsVerified: 0,
  };
  if (!stripeSecretKey) {
    return {
      ok: false,
      code: 'STRIPE_CONFIGURATION_UNAVAILABLE',
      error: 'Stripe is unavailable, so the customer funds cannot be reverified before payout.',
    };
  }

  const stripe = stripeClient || new Stripe(stripeSecretKey);
  const keyLiveMode = expectedLiveMode(stripeSecretKey);
  for (const event of stripeEvents) {
    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(event.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
    } catch (stripeError) {
      console.error('Payout manual Stripe recheck failed:', stripeError);
      return {
        ok: false,
        code: 'STRIPE_PAYMENT_REVERIFICATION_FAILED',
        error: 'Stripe could not reverify the customer payment. Do not pay the Easer until the payment is reconciled.',
      };
    }
    if (!manualStripeEventMatches(event, intent, keyLiveMode)) {
      return {
        ok: false,
        code: 'STRIPE_PAYMENT_NO_LONGER_CLEAR',
        error: 'A recorded Stripe payment is refunded, disputed, incomplete, or no longer matches the ledger. Resolve it before paying the Easer.',
      };
    }
    const chargeId = objectId(intent.latest_charge);
    let refundPage;
    try {
      refundPage = await stripe.refunds.list({ charge: chargeId, limit: 100 });
    } catch (stripeError) {
      console.error('Payout manual Stripe refund recheck failed:', stripeError);
      return {
        ok: false,
        code: 'STRIPE_REFUND_REVERIFICATION_FAILED',
        error: 'Stripe could not reverify the customer refund history. Do not pay the Easer until it is reconciled.',
      };
    }
    if (refundPage?.has_more) {
      return {
        ok: false,
        code: 'STRIPE_REFUND_PAGINATION_REQUIRED',
        error: 'The Stripe payment has too many refund events for automatic verification. Reconcile it before paying the Easer.',
      };
    }
    const refunds = Array.isArray(refundPage?.data) ? refundPage.data : [];
    const succeededRefundedCents = refunds
      .filter(refund => refund.status === 'succeeded')
      .reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    const hasPendingRefund = refunds.some(refund =>
      !['succeeded', 'failed', 'canceled'].includes(String(refund.status || '')));
    if (hasPendingRefund || succeededRefundedCents !== Number(event.refunded_cents || 0)) {
      return {
        ok: false,
        code: 'STRIPE_REFUND_NO_LONGER_CLEAR',
        error: 'A recorded Stripe refund is pending or no longer matches the booking ledger. Resolve it before paying the Easer.',
      };
    }
  }

  return {
    ok: true,
    collectedCents,
    grossCollectedCents,
    refundedCents,
    stripeEventsVerified: stripeEvents.length,
  };
}
