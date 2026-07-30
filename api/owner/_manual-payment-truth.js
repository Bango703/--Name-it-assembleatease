import Stripe from 'stripe';

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
  const amountCents = Number(event?.amount_cents);
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
    && Number(charge.amount_captured || charge.amount) === amountCents
    && Number(charge.amount_refunded || 0) === 0
    && charge.refunded !== true
    && charge.disputed !== true
  );
}

export async function verifyOwnerManualCustomerFundsForPayout({
  sb,
  booking,
  stripeSecretKey = process.env.STRIPE_SECRET_KEY,
  stripeClient = null,
}) {
  const { data: events, error } = await sb
    .from('owner_manual_payment_events')
    .select('amount_cents, payment_method, stripe_payment_intent_id, stripe_charge_id')
    .eq('booking_id', booking.id)
    .order('created_at', { ascending: true });

  if (error) {
    return {
      ok: false,
      code: 'OWNER_MANUAL_PAYMENT_LEDGER_UNAVAILABLE',
      error: 'Customer payment history is unavailable. Do not pay the Easer until migration 044 and the payment ledger are verified.',
    };
  }

  if (!events?.length) {
    const method = String(booking.payment_method || '').toLowerCase();
    if (['stripe_manual', 'card_on_site', 'mixed'].includes(method)) {
      return {
        ok: false,
        code: 'LEGACY_STRIPE_PAYMENT_RECONCILIATION_REQUIRED',
        error: 'This manual Stripe collection predates the verified payment ledger. Reconcile it before paying the Easer.',
      };
    }
    return { ok: true, legacyNonStripe: true };
  }

  const collectedCents = events.reduce((sum, event) => sum + Number(event.amount_cents || 0), 0);
  if (booking.payment_collected !== true || collectedCents !== Number(booking.total_price || 0)) {
    return {
      ok: false,
      code: 'OWNER_MANUAL_PAYMENT_BALANCE_REMAINS',
      error: 'The verified customer payments do not equal the booking total. Collect and record the remaining balance before paying the Easer.',
    };
  }

  const stripeEvents = events.filter(event => ['stripe_manual', 'card_on_site'].includes(event.payment_method));
  if (!stripeEvents.length) return { ok: true, collectedCents, stripeEventsVerified: 0 };
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
  }

  return {
    ok: true,
    collectedCents,
    stripeEventsVerified: stripeEvents.length,
  };
}
