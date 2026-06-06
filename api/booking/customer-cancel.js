import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';

/**
 * POST /api/booking/customer-cancel
 * Customer self-service booking cancellation.
 * Requires Bearer JWT (customer session).
 * Body: { bookingId }
 * - Free if cancelled 24+ hrs before appointment
 * - 50% fee if cancelled within 24 hrs of appointment
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Verify this booking belongs to the requesting customer
  if (booking.customer_id && booking.customer_id !== user.id) {
    return res.status(403).json({ error: 'This booking does not belong to your account' });
  }

  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });

  // Determine if within 24hr cancellation window of appointment
  let withinWindow = false;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    const hoursAway = apptMs != null ? (apptMs - Date.now()) / 3600000 : -1;
    withinWindow = hoursAway >= 0 && hoursAway < 24;
  } catch (e) { console.error('Date parse error:', e); }

  // Stripe: release hold or charge cancellation fee
  let feeCaptured = 0;
  const stripeMutationRequired = booking.payment_status === 'authorized';
  if (stripeMutationRequired && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Cancellation is temporarily unavailable. Please contact support.' });
  }
  if (stripeMutationRequired && !booking.stripe_payment_intent_id) {
    return res.status(409).json({ error: 'This booking needs manual cancellation help. Please contact support.' });
  }

  if (stripeMutationRequired) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      if (withinWindow && (booking.total_price || 0) > 0) {
        const feeCents = Math.round((booking.total_price || 0) * 0.5);
        const idempotencyKey = `customer-cancel-fee-${booking.id}-${feeCents}`;
        await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, { amount_to_capture: feeCents }, { idempotencyKey });
        feeCaptured = feeCents;
        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_cancel_customer',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { reason: 'customer_cancel_fee', feeCaptured },
        });
      } else {
        const idempotencyKey = `customer-cancel-release-${booking.id}`;
        await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
        await writeFinancialAudit(sb, {
          eventType: 'capture_release',
          eventSource: 'booking_cancel_customer',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { reason: 'customer_cancel_release' },
        });
      }
    } catch (e) {
      console.error('Stripe cancel error:', e);
      await writeFinancialAudit(sb, {
        eventType: 'booking_cancel_financial',
        eventSource: 'booking_cancel_customer',
        bookingId: booking.id,
        paymentIntentId: booking.stripe_payment_intent_id,
        status: 'failed',
        metadata: { paymentStatus: booking.payment_status, withinWindow },
        error: e?.message || 'Customer cancellation Stripe mutation failed',
      });
      return res.status(502).json({ error: 'We could not complete the payment portion of this cancellation. Your booking is unchanged. Please try again or contact support.' });
    }
  }

  const { error: updateErr } = await sb.from('bookings').update({
    status: BOOKING_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancel_reason: 'Cancelled by customer',
    cancellation_fee: feeCaptured || null,
  }).eq('id', booking.id);

  if (updateErr) {
    console.error('Customer cancel update failed:', updateErr);
    return res.status(500).json({ error: 'Unable to process cancellation. Please call us at (737) 290-6129.' });
  }

  // Cancel all open dispatch offers so Easers cannot accept a cancelled booking
  sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .then(({ error: doErr }) => {
      if (doErr) console.error('dispatch_offers customer-cancel cleanup error:', doErr.message);
    });

  // Release the assigned Easer's daily job slot (if one was assigned)
  if (booking.assembler_id) {
    adjustActiveJobs(sb, booking.assembler_id, -1).catch(() => {});
  }

  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'cancelled',
    actorType: 'customer',
    actorId: user.id,
    actorName: booking.customer_name || 'Customer',
    description: 'Booking cancelled by authenticated customer',
    metadata: {
      feeCaptured,
      withinWindow,
      reason: 'Cancelled by customer',
    },
  });

  // Email customer
  try {
    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
           A late-cancellation fee of <strong>$${(feeCaptured/100).toFixed(2)}</strong> (50% of total) was charged as this cancellation was within 24 hours of your appointment.
         </p>`
      : `<p style="margin:0 0 16px;font-size:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;color:#166534">
           No charge — your card hold has been released.
         </p>`;

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Booking Cancelled — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: 'CANCELLED',
        statusColor: '#71717a',
        statusBg: '#f4f4f5',
        headline: `Your booking has been cancelled.`,
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your booking for <strong>${esc(booking.service)}</strong> on <strong>${esc(booking.date)}</strong> has been cancelled as requested.</p>
          ${feeHtml}
          <p style="margin:0;font-size:14px;color:#52525b">Ready to rebook? <a href="https://www.assembleatease.com/book" style="color:#00BFFF;font-weight:600">Schedule a new appointment</a> anytime.</p>`,
      }),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Customer cancel email error:', e); }

  // Notify owner
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer Cancelled — ${booking.ref}`,
      html: `<p>Customer <strong>${esc(booking.customer_name)}</strong> cancelled booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p>
<p>Job date: ${esc(booking.date)} at ${esc(booking.time)}${feeCaptured > 0 ? ' — Cancellation fee of $' + (feeCaptured/100).toFixed(2) + ' charged.' : ' — No fee charged (>24hr notice).'}</p>`,
    });
  } catch (e) { console.error('Owner cancel notify error:', e); }

  console.log(JSON.stringify({ audit: true, action: 'booking_cancel', actor: 'customer', customerId: user.id, bookingId: booking.id, ref: booking.ref, feeCaptured, withinWindow, timestamp: new Date().toISOString() }));
  return res.status(200).json({ success: true, feeCaptured, withinWindow });
}
