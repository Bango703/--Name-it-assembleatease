import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, computeCancellationFee, computeBookingSplit } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { writeFinancialAudit } from '../_financial-audit.js';

/**
 * POST /api/booking/guest-cancel
 * Guest self-service booking cancellation — no login required.
 * Authenticates via email + booking ref (two-factor without password).
 * Body: { email, ref }
 * - Free 24h+ before appointment → void Stripe auth hold
 * - Tiered fee (10% within 24h · 15% imminent/no-show) on the pre-tax service subtotal → partial Stripe capture
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

  // Timing → tiered cancellation fee (% of pre-tax service subtotal, never tax).
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - Date.now()) / 3600000;
  } catch (e) { console.error('Date parse error:', e); }

  // A rescheduled booking forfeits its free window (disclosed at reschedule time).
  let wasRescheduled = false;
  try {
    const { count } = await sb
      .from('activity_logs')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', booking.id)
      .eq('event_type', 'rescheduled');
    wasRescheduled = (count || 0) > 0;
  } catch (e) { console.warn('Reschedule-lock check failed (continuing):', e.message); }

  const serviceSubtotalCents = Math.max(0,
    (booking.total_price || 0) - (booking.tax_amount || 0) - (booking.service_call_fee || 0));
  const policy = computeCancellationFee({
    serviceSubtotalCents,
    hoursUntilAppointment: hoursAway,
    status: booking.status,
    forfeitFreeWindow: wasRescheduled,
  });
  const withinWindow = policy.tier !== 'free';

  // Stripe: release hold or capture the tiered cancellation fee
  let feeCaptured = 0;
  let proTripCutCents = 0;
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
      if (policy.feeCents > 0) {
        const feeCents = policy.feeCents;
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
          metadata: { reason: (wasRescheduled && policy.tier === 'late') ? 'guest_cancel_fee_rescheduled' : 'guest_cancel_fee', feeCaptured, tier: policy.tier, feePct: policy.feePct, wasRescheduled },
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
          metadata: { reason: 'guest_cancel_release', tier: policy.tier },
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
        metadata: { paymentStatus: booking.payment_status, tier: policy.tier },
        error: e?.message || 'Guest cancellation Stripe mutation failed',
      });
      return res.status(502).json({ error: 'We could not complete the payment portion of this cancellation. Your booking is unchanged. Please try again or call us at (737) 290-6129.' });
    }
  }

  // Pro trip cut: pro committed (en route / no-show tier) → their split of the fee, recorded for manual payout.
  if (feeCaptured > 0 && policy.proTripCut && booking.assembler_id) {
    try {
      const { data: easerProf } = await sb.from('profiles').select('has_membership').eq('id', booking.assembler_id).single();
      proTripCutCents = computeBookingSplit(feeCaptured, easerProf?.has_membership === true, { taxCents: 0 }).assemblerDueCents;
    } catch (e) { console.error('pro trip-cut calc error:', e); }
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
      tier: policy.tier,
      feePct: policy.feePct,
      proTripCutCents,
      reason: 'Cancelled by customer (guest)',
    },
  });

  // Email customer
  try {
    const feeReasonText = (wasRescheduled && policy.tier === 'late')
      ? 'applies because this booking had been rescheduled (rescheduled bookings are not eligible for free cancellation)'
      : (policy.tier === 'imminent'
          ? 'applies because the appointment was within 2 hours or a pro was already on the way'
          : 'applies because this cancellation was within 24 hours of your appointment');
    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
           A cancellation fee of <strong>$${(feeCaptured / 100).toFixed(2)}</strong> (${policy.feePct}% of the service subtotal &mdash; no tax) ${feeReasonText}. The remainder of your hold has been released.
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
<p>Job date: ${esc(booking.date)} at ${esc(booking.time)}${feeCaptured > 0 ? ' — Cancellation fee of $' + (feeCaptured / 100).toFixed(2) + ' (' + policy.feePct + '% ' + policy.tier + ' tier) charged.' : ' — No fee charged (24h+ notice).'}</p>
${proTripCutCents > 0 ? '<p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 14px;color:#1e3a8a"><strong>Pro trip cut owed:</strong> $' + (proTripCutCents / 100).toFixed(2) + ' — a pro was committed/en route. Record a manual payout.</p>' : ''}`,
    });
  } catch (e) { console.error('Owner notify error:', e); }

  console.log(JSON.stringify({
    audit: true, action: 'booking_cancel', actor: 'guest',
    bookingId: booking.id, ref: booking.ref,
    feeCaptured, withinWindow, timestamp: new Date().toISOString(),
  }));

  return res.status(200).json({ success: true, feeCaptured, withinWindow, tier: policy.tier, feePct: policy.feePct, proTripCutCents });
}
