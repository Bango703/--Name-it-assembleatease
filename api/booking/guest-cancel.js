import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { writeFinancialAudit } from '../_financial-audit.js';

/**
 * POST /api/booking/guest-cancel
 * Guest self-service booking cancellation — no login required.
 * Authenticates via email + booking ref (two-factor without password).
 * Body: { email, ref }
 * - Free cancellation 24+ hrs before appointment → void Stripe auth hold
 * - 50% fee within 24 hrs → partial Stripe capture
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  // Stricter limit for cancel actions
  const ok = await rateLimit(ip, 'booking');
  if (!ok) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref } = req.body || {};
  if (!email || !ref) return res.status(400).json({ error: 'Email and booking reference are required.' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .ilike('customer_email', email.trim())
    .maybeSingle();

  if (fetchErr) {
    console.error('Guest cancel lookup error:', fetchErr);
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found. Check your reference and email.' });
  }

  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr + '.' });

  // Determine if within 24hr cancellation window
  let withinWindow = false;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    const hoursAway = apptMs != null ? (apptMs - Date.now()) / 3600000 : -1;
    withinWindow = hoursAway >= 0 && hoursAway < 24;
  } catch (e) { console.error('Date parse error:', e); }

  // A rescheduled booking forfeits free cancellation — the 50% fee applies on any
  // later cancellation regardless of the 24h window (disclosed at reschedule time).
  let wasRescheduled = false;
  try {
    const { count } = await sb
      .from('activity_logs')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', booking.id)
      .eq('event_type', 'rescheduled');
    wasRescheduled = (count || 0) > 0;
  } catch (e) { console.warn('Reschedule-lock check failed (continuing):', e.message); }

  const feeApplies = withinWindow || wasRescheduled;

  // Stripe: release hold or charge cancellation fee
  let feeCaptured = 0;
  const stripeMutationRequired = booking.payment_status === 'authorized';
  if (stripeMutationRequired && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Cancellation is temporarily unavailable. Please call us at (737) 290-6129.' });
  }
  if (stripeMutationRequired && !booking.stripe_payment_intent_id) {
    return res.status(409).json({ error: 'Your booking needs manual cancellation assistance. Please call us at (737) 290-6129.' });
  }

  if (stripeMutationRequired) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      if (feeApplies && (booking.total_price || 0) > 0) {
        const feeCents = Math.round((booking.total_price || 0) * 0.5);
        const idempotencyKey = `guest-cancel-fee-${booking.id}-${feeCents}`;
        await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, { amount_to_capture: feeCents }, { idempotencyKey });
        feeCaptured = feeCents;
        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_cancel_guest',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { reason: wasRescheduled && !withinWindow ? 'guest_cancel_fee_rescheduled' : 'guest_cancel_fee', feeCaptured, withinWindow, wasRescheduled },
        });
      } else {
        const idempotencyKey = `guest-cancel-release-${booking.id}`;
        await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
        await writeFinancialAudit(sb, {
          eventType: 'capture_release',
          eventSource: 'booking_cancel_guest',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { reason: 'guest_cancel_release' },
        });
      }
    } catch (e) {
      console.error('Stripe guest-cancel error:', e);
      await writeFinancialAudit(sb, {
        eventType: 'booking_cancel_financial',
        eventSource: 'booking_cancel_guest',
        bookingId: booking.id,
        paymentIntentId: booking.stripe_payment_intent_id,
        status: 'failed',
        metadata: { paymentStatus: booking.payment_status, withinWindow },
        error: e?.message || 'Guest cancellation Stripe mutation failed',
      });
      return res.status(502).json({ error: 'We could not complete the payment portion of this cancellation. Your booking is unchanged. Please try again or call us at (737) 290-6129.' });
    }
  }

  const { error: updateErr } = await sb.from('bookings').update({
    status: BOOKING_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancel_reason: 'Cancelled by customer (guest)',
    cancellation_fee: feeCaptured || null,
  }).eq('id', booking.id);

  if (updateErr) {
    console.error('Guest cancel update failed:', updateErr);
    return res.status(500).json({ error: 'Unable to process cancellation. Please call us at (737) 290-6129.' });
  }

  // Cancel all open dispatch offers so an Easer cannot accept a cancelled booking
  sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .then(({ error: doErr }) => {
      if (doErr) console.error('dispatch_offers cancel cleanup error (guest):', doErr.message);
    });

  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'cancelled',
    actorType: 'guest',
    actorName: booking.customer_name || 'Guest customer',
    description: 'Booking cancelled by guest via email+reference verification',
    metadata: {
      feeCaptured,
      withinWindow,
      reason: 'Cancelled by customer (guest)',
    },
  });

  // Email customer
  try {
    const feeReasonText = (wasRescheduled && !withinWindow)
      ? 'was charged because this booking had been rescheduled (rescheduled bookings are not eligible for free cancellation)'
      : 'was charged since this cancellation was within 24 hours of your appointment';
    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
           A cancellation fee of <strong>$${(feeCaptured / 100).toFixed(2)}</strong> (50% of your booking total) ${feeReasonText}.
         </p>`
      : `<p style="margin:0 0 16px;font-size:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;color:#166534">
           No charge &mdash; your card hold has been fully released.
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
        headline: 'Your booking has been cancelled.',
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your booking for <strong>${esc(booking.service)}</strong> on <strong>${esc(booking.date)}</strong> has been cancelled as requested.</p>
          ${feeHtml}
          <p style="margin:0;font-size:14px;color:#52525b">Ready to rebook? <a href="https://www.assembleatease.com/book" style="color:#00BFFF;font-weight:600">Schedule a new appointment</a> anytime.</p>`,
      }),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Guest cancel email error:', e); }

  // Notify owner
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer Cancelled (Guest) — ${booking.ref}`,
      html: `<p>Customer <strong>${esc(booking.customer_name)}</strong> cancelled booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}) via guest track page.</p>
<p>Job date: ${esc(booking.date)} at ${esc(booking.time)}${feeCaptured > 0 ? ' — Cancellation fee of $' + (feeCaptured / 100).toFixed(2) + ' charged.' : ' — No fee charged (&gt;24hr notice).'}</p>`,
    });
  } catch (e) { console.error('Owner notify error:', e); }

  console.log(JSON.stringify({
    audit: true, action: 'booking_cancel', actor: 'guest',
    bookingId: booking.id, ref: booking.ref,
    feeCaptured, withinWindow, timestamp: new Date().toISOString(),
  }));

  return res.status(200).json({ success: true, feeCaptured, withinWindow });
}
