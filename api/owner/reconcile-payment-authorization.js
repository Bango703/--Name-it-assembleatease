import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { buildStatusEmail, esc, ownerEmail, sendEmail, verifyOwner } from '../_email.js';
import { validateBookingPaymentIntent } from '../booking/_pending-payment-recovery.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { logActivity } from '../booking/_activity.js';

const REPAIRABLE_BOOKING_STATUSES = new Set(['pending', 'confirmed']);
const REPAIRABLE_PAYMENT_STATUSES = new Set(['pending', 'failed', 'authorized']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe payment verification is not configured.' });
  }

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: lookupError } = await sb.from('bookings')
    .select('id, ref, service, status, payment_status, payment_authorized_at, confirmed_at, customer_name, customer_email, date, time, address, total_price, stripe_payment_intent_id, assembler_id, financial_operation_key')
    .eq('id', bookingId)
    .maybeSingle();
  if (lookupError) return res.status(503).json({ error: 'Booking payment state could not be loaded.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.status === 'confirmed' && booking.payment_status === 'authorized') {
    return res.status(200).json({ ok: true, alreadyReconciled: true, bookingRef: booking.ref });
  }
  if (!REPAIRABLE_BOOKING_STATUSES.has(String(booking.status || ''))
      || !REPAIRABLE_PAYMENT_STATUSES.has(String(booking.payment_status || ''))
      || booking.financial_operation_key) {
    return res.status(409).json({
      error: 'This booking is not in a repairable authorization state. Review Stripe and the booking timeline manually.',
      code: 'PAYMENT_RECONCILIATION_STATE_BLOCKED',
    });
  }
  if (!booking.stripe_payment_intent_id) {
    return res.status(409).json({
      error: 'No linked Stripe PaymentIntent is available for reconciliation.',
      code: 'PAYMENT_INTENT_MISSING',
    });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
  } catch (stripeError) {
    console.error('[reconcile-payment-authorization] Stripe lookup failed:', stripeError?.message || stripeError);
    return res.status(502).json({ error: 'Stripe authorization could not be verified. No booking state changed.' });
  }

  const validation = validateBookingPaymentIntent(booking, intent);
  if (!validation.ok || intent.status !== 'requires_capture') {
    return res.status(409).json({
      error: intent.status === 'requires_action'
        ? 'The customer must finish card authentication before this booking can be reconciled.'
        : `Stripe does not show a valid uncaptured authorization for this booking (${intent.status || 'unknown'}).`,
      code: 'PAYMENT_AUTHORIZATION_NOT_VERIFIED',
    });
  }

  const now = new Date().toISOString();
  const { data: repairedRows, error: repairError } = await sb.from('bookings').update({
    status: 'confirmed',
    payment_status: 'authorized',
    payment_authorized_at: booking.payment_authorized_at || now,
    confirmed_at: booking.confirmed_at || now,
    confirmed_by: 'owner_stripe_reconciliation',
  })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('payment_status', booking.payment_status)
    .eq('stripe_payment_intent_id', intent.id)
    .is('financial_operation_key', null)
    .select('id');

  if (repairError || !repairedRows?.length) {
    const { data: current } = await sb.from('bookings')
      .select('status, payment_status, stripe_payment_intent_id')
      .eq('id', booking.id)
      .maybeSingle();
    if (current?.status === 'confirmed'
        && current?.payment_status === 'authorized'
        && current?.stripe_payment_intent_id === intent.id) {
      return res.status(200).json({ ok: true, alreadyReconciled: true, bookingRef: booking.ref });
    }
    console.error('[reconcile-payment-authorization] Booking repair failed:', repairError);
    return res.status(repairError ? 503 : 409).json({
      error: 'Stripe is authorized, but booking state could not be reconciled. Do not create another payment.',
      code: 'PAYMENT_RECONCILIATION_PERSIST_FAILED',
    });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'payment_authorization_reconciled',
    actorType: 'owner',
    actorName: 'Owner',
    description: 'Owner reconciled the booking to a verified Stripe authorization and confirmed state.',
    metadata: { paymentIntentId: intent.id, priorStatus: booking.status, priorPaymentStatus: booking.payment_status },
  }).catch(error => console.error('[reconcile-payment-authorization] Timeline log failed:', error?.message || error));

  try {
    await dispatchBooking(booking.id);
  } catch (dispatchError) {
    console.error('[reconcile-payment-authorization] Dispatch retry failed:', dispatchError?.message || dispatchError);
  }

  const emailResult = await sendEmail({
    to: booking.customer_email,
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Booking confirmed - ${booking.ref}`,
    replyTo: ownerEmail(),
    html: buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'CONFIRMED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your booking is confirmed, ${esc(booking.customer_name)}!`,
      bodyHtml: `<p style="line-height:1.7">Your card authorization for <strong>${esc(booking.service)}</strong> is verified. Your appointment is scheduled for <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time)}</strong>. Payment is captured only after completed work, except for disclosed cancellation fees.</p><p style="line-height:1.7">Service address: ${esc(booking.address)}</p>`,
    }),
    meta: {
      bookingId: booking.id,
      notificationType: 'booking_confirmed_reconciliation',
      recipientType: 'customer',
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  return res.status(200).json({
    ok: true,
    bookingRef: booking.ref,
    status: 'confirmed',
    paymentStatus: 'authorized',
    notificationDelivered: emailResult?.ok === true && emailResult?.suppressed !== true,
    warnings: emailResult?.ok === true && emailResult?.suppressed !== true
      ? []
      : ['booking_confirmation_email_failed'],
  });
}
