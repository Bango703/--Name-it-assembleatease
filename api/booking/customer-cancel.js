import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { buildRequestId, getDeploymentMetadata, hashIdentifier, insertOperationalEventFailOpen } from '../_observability.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, computeCancellationFee, computeBookingSplit } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';

/**
 * POST /api/booking/customer-cancel
 * Customer self-service booking cancellation.
 * Requires Bearer JWT (customer session).
 * Body: { bookingId }
 * Tiered fee on the PRE-TAX service subtotal (see computeCancellationFee):
 * - Free 24h+ before · 10% within 24h · 15% if a pro is en route / no-show (never 100%)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const requestId = buildRequestId(req.headers || {});
  const deployment = getDeploymentMetadata() || {};

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

  const normalizedUserEmail = String(user.email || '').trim().toLowerCase();
  const normalizedBookingEmail = String(booking.customer_email || '').trim().toLowerCase();
  const customerIdMatches = !!booking.customer_id && booking.customer_id === user.id;
  const customerEmailMatches = !!normalizedUserEmail && !!normalizedBookingEmail && normalizedBookingEmail === normalizedUserEmail;

  // Verify this booking belongs to the requesting customer by either bound
  // customer_id or the booking email when no account link exists yet.
  if (!customerIdMatches && !customerEmailMatches) {
    await insertOperationalEventFailOpen(sb, {
      event_type: 'customer_cancel_forbidden',
      request_id: requestId,
      route: '/api/booking/customer-cancel',
      method: req.method,
      deployment_id: deployment.deployment_id || null,
      commit_sha: deployment.commit_sha || null,
      environment: deployment.environment || null,
      app_version: deployment.app_version || null,
      actor_role: 'customer',
      actor_id_hash: hashIdentifier(user.id, { prefix: 'cu' }),
      booking_hash: hashIdentifier(booking.id, { prefix: 'bk' }),
      stage: 'authorization',
      status_code: 403,
      reason_code: 'forbidden_booking_access',
      reason_detail: 'Authenticated user attempted to cancel a booking they do not own.',
      mutation_result: 'rejected',
      latency_ms: null,
      payload: {
        has_customer_id: !!booking.customer_id,
        customer_id_match: customerIdMatches,
        customer_email_match: customerEmailMatches,
      },
    });

    return res.status(403).json({ error: 'This booking does not belong to your account' });
  }

  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });

  // Timing → tiered cancellation fee (% of pre-tax service subtotal, never tax).
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - Date.now()) / 3600000;
  } catch (e) { console.error('Date parse error:', e); }

  const serviceSubtotalCents = Math.max(0,
    (booking.total_price || 0) - (booking.tax_amount || 0) - (booking.service_call_fee || 0));
  const policy = computeCancellationFee({
    serviceSubtotalCents,
    hoursUntilAppointment: hoursAway,
    status: booking.status,
  });
  const withinWindow = policy.tier !== 'free';

  // Stripe: release hold or capture the tiered cancellation fee
  let feeCaptured = 0;
  let proTripCutCents = 0;
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
      if (policy.feeCents > 0) {
        const feeCents = policy.feeCents;
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
          metadata: { reason: 'customer_cancel_fee', feeCaptured, tier: policy.tier, feePct: policy.feePct },
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
          metadata: { reason: 'customer_cancel_release', tier: policy.tier },
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
        metadata: { paymentStatus: booking.payment_status, tier: policy.tier },
        error: e?.message || 'Customer cancellation Stripe mutation failed',
      });
      return res.status(502).json({ error: 'We could not complete the payment portion of this cancellation. Your booking is unchanged. Please try again or contact support.' });
    }
  }

  // Pro trip cut: if a pro was committed (en route / no-show tier) and a fee was
  // captured, the pro earns their normal split of the fee — recorded for the
  // owner to pay out (launch is manual-payout mode).
  if (feeCaptured > 0 && policy.proTripCut && booking.assembler_id) {
    try {
      const { data: easerProf } = await sb.from('profiles').select('has_membership').eq('id', booking.assembler_id).single();
      proTripCutCents = computeBookingSplit(feeCaptured, easerProf?.has_membership === true, { taxCents: 0 }).assemblerDueCents;
    } catch (e) { console.error('pro trip-cut calc error:', e); }
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
      tier: policy.tier,
      feePct: policy.feePct,
      proTripCutCents,
      reason: 'Cancelled by customer',
    },
  });

  // Email customer
  try {
    const feeReason = policy.tier === 'imminent'
      ? 'because the appointment was within 2 hours or a pro was already on the way'
      : 'because this was within 24 hours of your appointment';
    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
           A cancellation fee of <strong>$${(feeCaptured/100).toFixed(2)}</strong> (${policy.feePct}% of the service subtotal — no tax) was charged ${feeReason}. The remainder of your hold has been released.
         </p>`
      : `<p style="margin:0 0 16px;font-size:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;color:#166534">
           No charge — your card hold has been released in full.
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
<p>Job date: ${esc(booking.date)} at ${esc(booking.time)}${feeCaptured > 0 ? ' — Cancellation fee of $' + (feeCaptured/100).toFixed(2) + ' (' + policy.feePct + '% ' + policy.tier + ' tier) charged.' : ' — No fee charged (24h+ notice).'}</p>
${proTripCutCents > 0 ? '<p style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 14px;color:#1e3a8a"><strong>Pro trip cut owed:</strong> $' + (proTripCutCents/100).toFixed(2) + ' — a pro was committed/en route. Record a manual payout.</p>' : ''}`,
    });
  } catch (e) { console.error('Owner cancel notify error:', e); }

  console.log(JSON.stringify({ audit: true, action: 'booking_cancel', actor: 'customer', customerId: user.id, bookingId: booking.id, ref: booking.ref, feeCaptured, withinWindow, timestamp: new Date().toISOString() }));
  return res.status(200).json({ success: true, feeCaptured, withinWindow, tier: policy.tier, feePct: policy.feePct, proTripCutCents });
}
