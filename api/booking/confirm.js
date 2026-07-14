import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  // Fetch the booking
  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CONFIRMED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });
  if (booking.financial_operation_key || booking.financial_operation_type) {
    return res.status(409).json({
      error: 'A cancellation or payment action is already being reconciled. Refresh before confirming this booking.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  if (['quote_pending_approval', 'quote_authorization_pending', 'card_saved'].includes(booking.payment_status)
      || (booking.quote_amount_cents && !booking.quote_approved_at)) {
    return res.status(409).json({
      error: 'Custom quotes must be approved by the customer through the secure quote link before confirmation.',
      code: 'CUSTOMER_QUOTE_APPROVAL_REQUIRED',
    });
  }

  const totalCents = Number(booking.total_price || 0);
  let confirmedBy = 'owner_payment_verified';
  if (totalCents > 0) {
    if (booking.payment_status !== 'authorized' || !booking.stripe_payment_intent_id || !process.env.STRIPE_SECRET_KEY) {
      return res.status(409).json({
        error: 'Positive-price bookings require a verified Stripe authorization before confirmation.',
        code: 'PAYMENT_NOT_AUTHORIZED',
      });
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let pi;
    try { pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id); }
    catch (stripeErr) {
      console.error('Owner confirm Stripe verification failed:', stripeErr);
      return res.status(502).json({ error: 'Could not verify Stripe authorization. Booking was not confirmed.' });
    }
    const validIntent = pi.status === 'requires_capture'
      && pi.capture_method === 'manual'
      && pi.currency === 'usd'
      && pi.amount === totalCents
      && pi.metadata?.bookingId === booking.id
      && ['customer_booking', 'customer_quote'].includes(pi.metadata?.type);
    if (!validIntent) {
      return res.status(409).json({
        error: 'Stripe authorization does not match this booking. Booking was not confirmed.',
        code: 'PAYMENT_BOOKING_MISMATCH',
      });
    }
  } else {
    if (process.env.VERCEL_ENV === 'production' || req.body?.allowZeroSimulation !== true) {
      return res.status(409).json({
        error: 'Zero-dollar bookings cannot be owner-confirmed in production. In non-production, explicit simulation approval is required.',
        code: 'ZERO_DOLLAR_CONFIRMATION_BLOCKED',
      });
    }
    confirmedBy = 'owner_zero_dollar_simulation';
  }

  // Update status
  let confirmUpdate = sb
    .from('bookings')
    .update({ status: BOOKING_STATUS.CONFIRMED, confirmed_at: new Date().toISOString(), confirmed_by: confirmedBy })
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.PENDING)
    .eq('payment_status', booking.payment_status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null);
  confirmUpdate = booking.total_price == null
    ? confirmUpdate.is('total_price', null)
    : confirmUpdate.eq('total_price', booking.total_price);
  confirmUpdate = booking.stripe_payment_intent_id == null
    ? confirmUpdate.is('stripe_payment_intent_id', null)
    : confirmUpdate.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
  const { error: updateErr, data: updatedRows } = await confirmUpdate.select('id');

  if (updateErr) {
    console.error('Confirm update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }
  if (!updatedRows?.length) {
    return res.status(409).json({
      error: 'Booking or payment state changed before confirmation. Refresh before trying again.',
      code: 'CONFIRMATION_STATE_RACE',
    });
  }

  // Send confirmation email to customer
  try {
    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'CONFIRMED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your booking is confirmed, ${esc(booking.customer_name)}!`,
      bodyHtml: `
        <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.date)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.time)}</td></tr>
          <tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(booking.address)}</td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
          <strong style="color:#1a1a1a">Cancellation policy:</strong> We ask for at least 24 hours' notice to cancel or reschedule.
        </td></tr></table>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Booking Confirmed — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Confirm email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'appointmentscheduled').catch(e => console.error('HubSpot confirm stage error:', e));
  }

  logActivity(sb, { bookingId: booking.id, eventType: 'confirmed', actorType: 'owner', actorName: 'Owner', description: 'Booking confirmed by owner' });
  try { await dispatchBooking(booking.id); }
  catch (dispatchErr) { console.error('Auto-dispatch error:', dispatchErr?.message || dispatchErr); }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.CONFIRMED } });
}
