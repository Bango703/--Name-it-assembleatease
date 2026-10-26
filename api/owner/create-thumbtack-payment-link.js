import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { randomToken, sha256 } from '../_payment-security.js';
import { logActivity } from '../booking/_activity.js';
import { isRecoverablePaymentIntentStatus, validateBookingPaymentIntent } from '../booking/_pending-payment-recovery.js';

const SITE = String(process.env.PUBLIC_SITE_URL || 'https://www.assembleatease.com').replace(/\/$/, '');
// Reuse the existing constrained payment-recovery lock bucket so link setup
// does not require a second database migration just to widen the lock enum.
const LOCK_TYPE = 'payment_recovery_replacement';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PUBLISHABLE_KEY) {
    return res.status(503).json({ error: 'AAE Stripe authorization is not configured.' });
  }

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required.' });
  const sb = getSupabase();
  const { data: booking, error: readError } = await sb.from('bookings')
    .select('id, ref, source, service, customer_name, customer_email, customer_phone, status, payment_status, payment_method, payment_collected, external_platform, external_agreement_verified_at, external_payment_reference, total_price, stripe_payment_intent_id, stripe_customer_id, payment_method_type, payment_recovery_token_hash, financial_operation_key, financial_operation_type, financial_operation_started_at, financial_reconciliation_required_at, cancellation_reconciliation_required_at')
    .eq('id', bookingId)
    .maybeSingle();
  if (readError) return res.status(503).json({ error: 'Booking payment state could not be verified.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  if (booking.source !== 'owner_manual'
      || booking.external_platform !== 'thumbtack'
      || !booking.external_agreement_verified_at
      || booking.status !== 'confirmed'
      || !['offline_recorded', 'pending', 'failed'].includes(String(booking.payment_status || ''))
      || booking.payment_collected === true
      || booking.external_payment_reference
      || Number(booking.total_price || 0) <= 0) {
    return res.status(409).json({
      error: 'This booking is not eligible for a new AAE Stripe authorization. Verify its payment and booking state first.',
      code: 'THUMBTACK_PAYMENT_STATE_NOT_ELIGIBLE',
    });
  }
  if ((booking.payment_status === 'offline_recorded' && booking.payment_method !== 'thumbtack')
      || (booking.payment_status !== 'offline_recorded' && booking.payment_method != null)) {
    return res.status(409).json({ error: 'The booking has conflicting payment records. Reconcile it before creating a card link.', code: 'THUMBTACK_PAYMENT_RECORD_CONFLICT' });
  }
  if (hasFinancialHold(booking)) {
    return res.status(409).json({ error: 'A financial action is already in progress. Resolve it before creating a payment link.', code: 'FINANCIAL_OPERATION_IN_PROGRESS' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let intent = null;
  if (booking.stripe_payment_intent_id) {
    try {
      intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    } catch (error) {
      console.error('[thumbtack-payment-link] Stripe lookup failed:', error?.message || error);
      return res.status(502).json({ error: 'Stripe payment state could not be verified.' });
    }
    const valid = validateBookingPaymentIntent(booking, intent);
    if (!valid.ok || !isRecoverablePaymentIntentStatus(intent.status)) {
      return res.status(409).json({ error: 'The existing Stripe payment needs reconciliation before a new link can be issued.', code: 'THUMBTACK_STRIPE_INTENT_NOT_RECOVERABLE' });
    }
  } else if (booking.payment_status !== 'offline_recorded' || booking.payment_method !== 'thumbtack') {
    return res.status(409).json({ error: 'No safe Stripe authorization is linked to this booking.', code: 'THUMBTACK_STRIPE_INTENT_MISSING' });
  }

  const token = randomToken(32);
  const tokenHash = sha256(token);
  const operationKey = `thumbtack-stripe-hold:${booking.id}:${tokenHash.slice(0, 16)}`;
  const locked = await sb.from('bookings').update({
    financial_operation_key: operationKey,
    financial_operation_type: LOCK_TYPE,
    financial_operation_started_at: new Date().toISOString(),
  })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('payment_status', booking.payment_status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null)
    .is('financial_reconciliation_required_at', null)
    .is('cancellation_reconciliation_required_at', null)
    .select('id');
  if (locked.error) return res.status(503).json({ error: 'Payment could not be safely prepared.' });
  if (!locked.data?.length) return res.status(409).json({ error: 'Booking payment state changed. Refresh and try again.' });

  let createdIntent = false;
  try {
    let customerId = booking.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: booking.customer_name || undefined,
        email: booking.customer_email || undefined,
        phone: booking.customer_phone || undefined,
        metadata: { bookingId: booking.id, source: 'thumbtack' },
      }, { idempotencyKey: `thumbtack-stripe-customer-${booking.id}` });
      customerId = customer.id;
    }

    if (!intent) {
      intent = await stripe.paymentIntents.create({
        amount: Number(booking.total_price),
        currency: 'usd',
        customer: customerId,
        capture_method: 'manual',
        payment_method_types: ['card'],
        receipt_email: booking.customer_email || undefined,
        statement_descriptor_suffix: 'ASSEMBLEATEASE',
        description: `Thumbtack booking ${booking.ref} - ${booking.service}`,
        metadata: {
          bookingId: booking.id,
          bookingRef: booking.ref,
          type: 'customer_booking',
          paymentMethodType: 'card',
          leadSource: 'thumbtack',
        },
      }, { idempotencyKey: `thumbtack-stripe-hold-${booking.id}-${tokenHash.slice(0, 20)}-${Number(booking.total_price)}` });
      createdIntent = true;
    }
    const intentBooking = { ...booking, stripe_payment_intent_id: intent.id, stripe_customer_id: customerId };
    const validation = validateBookingPaymentIntent(intentBooking, intent);
    if (!intent.client_secret || !validation.ok || !isRecoverablePaymentIntentStatus(intent.status)) {
      if (createdIntent) await cancelUnlinkedIntent(stripe, sb, booking.id, intent.id);
      await releaseLock(sb, booking.id, operationKey);
      return res.status(502).json({ error: 'Stripe did not prepare a usable card authorization. No link was issued.' });
    }

    const expiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const update = {
      stripe_payment_intent_id: intent.id,
      stripe_customer_id: customerId,
      payment_status: 'pending',
      payment_method: null,
      payment_method_type: 'card',
      payment_recovery_token_hash: tokenHash,
      authorization_capture_before: null,
      external_payment_authorization_expires_at: expiry,
      financial_operation_key: null,
      financial_operation_type: null,
      financial_operation_started_at: null,
    };
    const linked = await sb.from('bookings').update(update)
      .eq('id', booking.id)
      .eq('status', booking.status)
      .eq('payment_status', booking.payment_status)
      .eq('financial_operation_key', operationKey)
      .eq('financial_operation_type', LOCK_TYPE)
      .is('financial_reconciliation_required_at', null)
      .is('cancellation_reconciliation_required_at', null)
      .select('id');
    if (linked.error || !linked.data?.length) {
      const current = await sb.from('bookings').select('stripe_payment_intent_id, payment_recovery_token_hash').eq('id', booking.id).maybeSingle();
      const linkedByConcurrentRequest = current.data?.stripe_payment_intent_id === intent.id && current.data?.payment_recovery_token_hash === tokenHash;
      if (!linkedByConcurrentRequest) {
        if (createdIntent) await cancelUnlinkedIntent(stripe, sb, booking.id, intent.id);
        await releaseLock(sb, booking.id, operationKey);
        return res.status(linked.error ? 503 : 409).json({ error: 'Payment linkage could not be verified. No link was issued.', code: 'THUMBTACK_STRIPE_LINKAGE_UNVERIFIED' });
      }
    }

    await logActivity(sb, {
      bookingId: booking.id,
      eventType: 'thumbtack_stripe_authorization_link_created',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'A secure AAE Stripe card authorization link was created. No payment was collected and no customer message was sent.',
      metadata: { paymentIntentId: intent.id, amountCents: Number(booking.total_price), expiresAt: expiry, leadSource: 'thumbtack' },
    }).catch(error => console.error('[thumbtack-payment-link] activity log failed:', error?.message || error));

    return res.status(200).json({
      success: true,
      bookingId: booking.id,
      bookingRef: booking.ref,
      totalCents: Number(booking.total_price),
      paymentIntentStatus: intent.status,
      expiresAt: expiry,
      paymentUrl: `${SITE}/api/booking/payment-recovery?bookingId=${encodeURIComponent(booking.id)}&token=${encodeURIComponent(token)}`,
      message: 'Link created. Copy it into the existing Thumbtack conversation only after confirming that no Thumbtack payment has already been initiated. No email or message was sent.',
    });
  } catch (error) {
    console.error('[thumbtack-payment-link] Stripe authorization preparation failed:', error?.message || error);
    if (createdIntent && intent?.id) {
      const { data: current } = await sb.from('bookings')
        .select('stripe_payment_intent_id')
        .eq('id', booking.id)
        .maybeSingle();
      if (current?.stripe_payment_intent_id !== intent.id) {
        await cancelUnlinkedIntent(stripe, sb, booking.id, intent.id);
      }
    }
    await releaseLock(sb, booking.id, operationKey);
    return res.status(502).json({ error: 'A secure card authorization link could not be prepared. No customer message was sent.' });
  }
}

function hasFinancialHold(booking) {
  return Boolean(booking?.financial_operation_key
    || booking?.financial_operation_type
    || booking?.financial_operation_started_at
    || booking?.financial_reconciliation_required_at
    || booking?.cancellation_reconciliation_required_at);
}

async function releaseLock(sb, bookingId, operationKey) {
  await sb.from('bookings').update({
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
  }).eq('id', bookingId).eq('financial_operation_key', operationKey);
}

async function cancelUnlinkedIntent(stripe, sb, bookingId, paymentIntentId) {
  try {
    const latest = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (latest.status !== 'canceled') {
      const cancelled = await stripe.paymentIntents.cancel(paymentIntentId);
      if (cancelled?.status !== 'canceled') throw new Error(`Stripe returned ${cancelled?.status || 'unknown'}`);
    }
  } catch (error) {
    console.error('[thumbtack-payment-link] unlinked intent could not be cancelled:', error?.message || error);
    await sb.from('bookings').update({
      dispatch_paused: true,
      needs_manual_dispatch: true,
      financial_reconciliation_required_at: new Date().toISOString(),
      financial_reconciliation_reason: 'An unlinked Thumbtack Stripe authorization could not be confirmed cancelled.',
    }).eq('id', bookingId).is('financial_reconciliation_required_at', null);
    await logActivity(sb, {
      bookingId,
      eventType: 'thumbtack_stripe_unlinked_intent_reconciliation_required',
      actorType: 'system',
      actorName: 'payment-link',
      description: 'An unlinked Stripe authorization could not be confirmed cancelled and requires owner review.',
      metadata: { paymentIntentId, error: error?.message || String(error) },
    }).catch(() => {});
  }
}
