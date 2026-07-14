import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, computeCancellationFee, computeBookingSplitAtFeePct } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { writeFinancialAudit, writeFinancialAuditRequired } from '../_financial-audit.js';
import { safeTokenHashMatch } from '../_payment-security.js';
import { reserveBookingFinancialOperation } from './_financial-operation.js';
import { resolveOrCreateEaserFeeSnapshot } from './_easer-fee-snapshot.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { reconcileCancellationAssembleCash } from './_cancellation-credits.js';
import { loadBookingRescheduleTruth } from './_cancellation-policy-truth.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';
import {
  CANCELLABLE_PAYMENT_INTENT_STATES,
  bookingCancellationPaymentIntentIds,
  isUnrefundedCancellationFeeCapture,
  loadBookingCancellationPaymentIntents,
} from './_cancellation-stripe-truth.js';
import {
  assertCancellationPayoutUnsettled,
  cancellationPolicyEvaluationTimeMs,
  hasDurableCancellationFeeCaptureAudit,
} from './_cancellation-operation.js';

async function cancelGuestIntent(stripe, booking, row) {
  if (row.intent.status === 'canceled') return;
  if (!CANCELLABLE_PAYMENT_INTENT_STATES.has(row.intent.status)) {
    const error = new Error(`Stripe authorization is in unexpected state ${row.intent.status}.`);
    error.code = 'OWNER_CANCELLATION_REQUIRED';
    throw error;
  }
  const canceled = await stripe.paymentIntents.cancel(
    row.paymentIntentId,
    {},
    { idempotencyKey: `guest-cancel-release-${booking.id}-${row.paymentIntentId}` },
  );
  if (canceled?.status !== 'canceled') {
    const error = new Error('Stripe did not confirm release of the card authorization.');
    error.code = 'OWNER_CANCELLATION_REQUIRED';
    throw error;
  }
}

async function holdGuestCancellation(sb, booking, operationKey, metadata = {}) {
  const { error: holdError, data: heldRows } = await sb.from('bookings').update({
    dispatch_paused: true,
    needs_manual_dispatch: false,
    dispatch_status: 'payment_hold',
    cancellation_reconciliation_required_at: new Date().toISOString(),
    cancellation_reconciliation_reason: metadata.code || 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED',
  })
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('financial_operation_key', operationKey)
    .select('id');
  const { error: offersError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
  if (holdError || !heldRows?.length) console.error('Guest cancellation hold failed:', holdError);
  if (offersError) console.error('Guest cancellation offer cleanup failed:', offersError);
  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'cancellation_payment_hold',
    actorType: 'guest',
    description: 'Guest cancellation paused for owner payment reconciliation',
    metadata,
  });
  return { ok: !holdError && !!heldRows?.length && !offersError };
}

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

  const { email, ref, token } = req.body || {};
  if (!email || !ref || !token) return res.status(400).json({ error: 'A secure booking link, email, and booking reference are required.' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .maybeSingle();

  if (fetchErr) {
    console.error('Guest cancel lookup error:', fetchErr);
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking || !bookingEmailMatches(booking, email)) {
    return res.status(404).json({ error: 'Booking not found. Check your reference and email.' });
  }
  if (!safeTokenHashMatch(token, booking.guest_mutation_token_hash)) {
    return res.status(403).json({ error: 'This secure booking link is invalid. Use the link in your confirmation email or contact support.' });
  }

  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr + '.' });
  if (booking.status === BOOKING_STATUS.IN_PROGRESS || booking.job_started_at) {
    return res.status(409).json({
      error: 'Work has already started. Contact support so job completion, payment, and any adjustment can be reviewed safely.',
      code: 'OWNER_CANCELLATION_REQUIRED',
    });
  }
  try {
    await assertCancellationPayoutUnsettled(sb, booking);
  } catch (payoutError) {
    return res.status(payoutError.code === 'CANCELLATION_PAYOUT_RECONCILIATION_REQUIRED' ? 409 : 503).json({
      error: payoutError.message,
      code: payoutError.code,
    });
  }

  // Timing → tiered cancellation fee (% of pre-tax service subtotal, never tax).
  const policyEvaluationTimeMs = cancellationPolicyEvaluationTimeMs(booking);
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - policyEvaluationTimeMs) / 3600000;
  } catch (e) { console.error('Date parse error:', e); }

  // A rescheduled booking forfeits its free window (disclosed at reschedule time).
  let wasRescheduled;
  try {
    ({ wasRescheduled } = loadBookingRescheduleTruth(booking));
  } catch (policyTruthError) {
    return res.status(503).json({ error: policyTruthError.message, code: policyTruthError.code });
  }

  const serviceSubtotalCents = Math.max(0,
    (booking.total_price || 0) - (booking.tax_amount || 0) - (booking.service_call_fee || 0));
  const policy = computeCancellationFee({
    serviceSubtotalCents,
    hoursUntilAppointment: hoursAway,
    status: booking.status,
    forfeitFreeWindow: wasRescheduled,
  });
  const withinWindow = policy.tier !== 'free';

  if (!['pending', 'failed', 'authorized', 'not_required'].includes(booking.payment_status)) {
    return res.status(409).json({
      error: 'This booking has a captured or deposit payment that requires owner-assisted cancellation. Contact support so the payment is reconciled before the booking changes.',
      code: 'OWNER_CANCELLATION_REQUIRED',
    });
  }

  let feeSnapshot = null;
  if (policy.proTripCut && booking.assembler_id) {
    try {
      feeSnapshot = await resolveOrCreateEaserFeeSnapshot(sb, booking, booking.assembler_id);
    } catch (feeError) {
      console.error('Guest cancellation fee snapshot error:', feeError);
      return res.status(503).json({ error: feeError.message, code: feeError.code });
    }
  }

  // Stripe: release hold or capture the tiered cancellation fee
  let feeCaptured = 0;
  let proTripCutCents = 0;
  if (booking.payment_status === 'cancellation_fee_captured') {
    feeCaptured = Number(booking.cancellation_fee || booking.amount_charged || 0);
  }
  const paymentIntentIds = bookingCancellationPaymentIntentIds(booking);
  const stripeMutationRequired = paymentIntentIds.length > 0;
  if (booking.payment_status === 'authorized' && !stripeMutationRequired) {
    return res.status(409).json({ error: 'Your booking needs manual cancellation assistance. Please call us at 737-290-6129.' });
  }
  if (stripeMutationRequired && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Cancellation is temporarily unavailable. Please call us at 737-290-6129.' });
  }

  const operationKey = `cancel:guest:${booking.id}`;
  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: 'cancel_guest',
      expectedStatuses: [booking.status],
      expectedAssemblerId: booking.assembler_id || null,
      expectedDate: booking.date,
      expectedTime: booking.time,
      checkAppointment: true,
      expectedBooking: booking,
    });
  } catch (reservationError) {
    return res.status(reservationError.code === 'FINANCIAL_OPERATION_CONFLICT' ? 409 : 503).json({
      error: reservationError.message,
      code: reservationError.code,
    });
  }

  if (stripeMutationRequired) {
    let stripeMutationStarted = false;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const intentRows = await loadBookingCancellationPaymentIntents(stripe, booking, {
        errorCode: 'OWNER_CANCELLATION_REQUIRED',
      });
      const invalidSucceededIntent = intentRows.find(row => row.intent.status === 'succeeded'
        && (!Number.isInteger(Number(row.intent.amount_received)) || Number(row.intent.amount_received) <= 0));
      if (invalidSucceededIntent) {
        for (const row of intentRows.filter(item => CANCELLABLE_PAYMENT_INTENT_STATES.has(item.intent.status))) {
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, row);
        }
        const error = new Error('Stripe captured payment totals require owner reconciliation.');
        error.code = 'OWNER_CANCELLATION_REQUIRED';
        throw error;
      }
      const unexpected = intentRows.find(row => row.intent.status !== 'succeeded'
        && row.intent.status !== 'canceled'
        && !CANCELLABLE_PAYMENT_INTENT_STATES.has(row.intent.status));
      if (unexpected) {
        for (const row of intentRows.filter(item => CANCELLABLE_PAYMENT_INTENT_STATES.has(item.intent.status))) {
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, row);
        }
        const error = new Error(`Stripe authorization is in unexpected state ${unexpected.intent.status}.`);
        error.code = 'OWNER_CANCELLATION_REQUIRED';
        throw error;
      }

      const capturedRows = intentRows.filter(row => row.intent.status === 'succeeded'
        && Number(row.intent.amount_received || 0) > 0);
      const feeRecoveryRow = capturedRows.length === 1 ? capturedRows[0] : null;
      const expectedRecoveredFee = feeRecoveryRow
        ? policy.feeCents
        : 0;
      const feeRecoveryMatchesStripe = isUnrefundedCancellationFeeCapture(
        feeRecoveryRow,
        booking,
        expectedRecoveredFee,
      );
      const canRecoverCancellationFee = feeRecoveryMatchesStripe
        && await hasDurableCancellationFeeCaptureAudit(sb, {
          booking,
          paymentIntentId: feeRecoveryRow.paymentIntentId,
          feeCents: expectedRecoveredFee,
        });

      if (capturedRows.length && !canRecoverCancellationFee) {
        for (const row of intentRows.filter(item => item.intent.status !== 'succeeded' && item.intent.status !== 'canceled')) {
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, row);
        }
        const error = new Error('A captured payment needs owner reconciliation before this booking can be cancelled.');
        error.code = 'OWNER_CANCELLATION_REQUIRED';
        throw error;
      }

      if (canRecoverCancellationFee) {
        for (const row of intentRows.filter(item => item !== feeRecoveryRow && item.intent.status !== 'canceled')) {
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, row);
        }
        feeCaptured = Number(feeRecoveryRow.intent.amount_received);
      } else {
        const primaryRow = intentRows.find(row => row.paymentIntentId === booking.stripe_payment_intent_id)
          || intentRows.find(row => row.paymentIntentId === booking.stripe_deposit_intent_id)
          || intentRows[0];
        const feeRow = primaryRow?.intent.status === 'requires_capture'
          && ['customer_booking', 'customer_quote', 'reauth'].includes(primaryRow.intent.metadata?.type)
          ? primaryRow
          : null;
        for (const row of intentRows) {
          if (row === feeRow || row.intent.status === 'canceled') continue;
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, row);
        }

        if (feeRow && policy.feeCents > 0) {
          if (feeRow.intent.capture_method !== 'manual'
              || Number(feeRow.intent.amount || 0) !== Number(booking.total_price || 0)
              || !Number.isInteger(Number(feeRow.intent.amount_capturable))
              || Number(feeRow.intent.amount_capturable) < policy.feeCents) {
            stripeMutationStarted = true;
            await cancelGuestIntent(stripe, booking, feeRow);
            const error = new Error('Stripe authorization amount or capture method does not match the server-priced booking.');
            error.code = 'OWNER_CANCELLATION_REQUIRED';
            throw error;
          }
          const feeCents = policy.feeCents;
          const idempotencyKey = `guest-cancel-fee-${booking.id}-${feeCents}`;
          stripeMutationStarted = true;
          const captured = await stripe.paymentIntents.capture(feeRow.paymentIntentId, { amount_to_capture: feeCents }, { idempotencyKey });
          if (captured?.status !== 'succeeded' || Number(captured.amount_received || 0) !== feeCents) {
            const error = new Error('Stripe did not confirm the exact cancellation fee capture.');
            error.code = 'OWNER_CANCELLATION_REQUIRED';
            throw error;
          }
          feeCaptured = feeCents;
          await writeFinancialAuditRequired(sb, {
            eventType: 'capture_attempt',
            eventSource: 'booking_cancel_guest',
            bookingId: booking.id,
            paymentIntentId: feeRow.paymentIntentId,
            idempotencyKey,
            status: 'processed',
            metadata: { reason: (wasRescheduled && policy.tier === 'late') ? 'guest_cancel_fee_rescheduled' : 'guest_cancel_fee', feeCaptured, tier: policy.tier, feePct: policy.feePct, wasRescheduled },
          });
        } else if (feeRow) {
          stripeMutationStarted = true;
          await cancelGuestIntent(stripe, booking, feeRow);
          await writeFinancialAuditRequired(sb, {
            eventType: 'capture_release',
            eventSource: 'booking_cancel_guest',
            bookingId: booking.id,
            paymentIntentId: feeRow.paymentIntentId,
            idempotencyKey: `guest-cancel-release-${booking.id}-${feeRow.paymentIntentId}`,
            status: 'processed',
            metadata: { reason: 'guest_cancel_release', tier: policy.tier },
          });
        }
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
      const held = await holdGuestCancellation(sb, booking, operationKey, {
        code: e?.code || 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED',
        stripeMutationStarted,
      });
      return res.status(held.ok && e?.code === 'OWNER_CANCELLATION_REQUIRED' ? 409 : 503).json({
        error: 'We could not fully reconcile the payment portion of this cancellation. Dispatch is paused; please call us at 737-290-6129.',
        code: e?.code || 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED',
        recoverable: true,
      });
    }
  }

  // Pro trip cut: pro committed (en route / no-show tier) → their split of the fee, recorded for manual payout.
  if (feeCaptured > 0 && policy.proTripCut && booking.assembler_id) {
    proTripCutCents = computeBookingSplitAtFeePct(feeCaptured, feeSnapshot.feePct, { taxCents: 0 }).assemblerDueCents;
  }
  const releasedWithoutCharge = stripeMutationRequired && feeCaptured === 0;

  const cancellationUpdate = {
    status: BOOKING_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancel_reason: 'Cancelled by customer (guest)',
    cancellation_fee: feeCaptured || null,
    payment_status: feeCaptured > 0
      ? 'cancellation_fee_captured'
      : (stripeMutationRequired ? 'authorization_released' : booking.payment_status),
    amount_charged: feeCaptured > 0 ? feeCaptured : (releasedWithoutCharge ? null : (booking.amount_charged || null)),
    payment_captured_at: feeCaptured > 0 ? new Date().toISOString() : (releasedWithoutCharge ? null : booking.payment_captured_at),
    cancellation_easer_due_cents: proTripCutCents,
    cancellation_easer_payout_status: proTripCutCents > 0 ? 'pending' : null,
    payout_status: proTripCutCents > 0 ? 'pending' : booking.payout_status,
    payout_mode_snapshot: proTripCutCents > 0
      ? (isStripeConnectEnabled() ? 'stripe_connect' : 'manual')
      : booking.payout_mode_snapshot,
    payout_review_status: proTripCutCents > 0 ? 'not_required' : booking.payout_review_status,
    cancellation_reconciliation_required_at: null,
    cancellation_reconciliation_reason: null,
  };
  let updateQuery = sb.from('bookings').update(cancellationUpdate)
    .eq('id', booking.id)
    .eq('status', booking.status)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'cancel_guest');
  updateQuery = booking.assembler_id
    ? updateQuery.eq('assembler_id', booking.assembler_id)
    : updateQuery.is('assembler_id', null);
  const { error: updateErr, data: updatedRows } = await updateQuery.select('id');

  if (updateErr || !updatedRows?.length) {
    console.error('Guest cancel update failed:', updateErr);
    await holdGuestCancellation(sb, booking, operationKey, {
      code: 'CANCELLATION_FINALIZE_FAILED',
      stripeReconciled: true,
    });
    return res.status(500).json({
      error: 'The payment action completed, but the cancellation could not be finalized. Please call us at 737-290-6129 and do not retry through another cancellation path.',
      code: 'CANCELLATION_FINALIZE_FAILED',
    });
  }

  const cancellationCredits = await reconcileCancellationAssembleCash(sb, booking, 'booking_cancel_guest', operationKey);

  // Cancel all open dispatch offers so an Easer cannot accept a cancelled booking
  const { error: dispatchCleanupError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
  if (dispatchCleanupError) console.error('dispatch_offers cancel cleanup error (guest):', dispatchCleanupError.message);

  if (booking.assembler_id) {
    await adjustActiveJobs(sb, booking.assembler_id, -1);
  }

  const timelineResult = await logActivity(sb, {
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
      meta: { bookingId: booking.id, notificationType: 'cancellation', recipientType: 'customer' },
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
      meta: { bookingId: booking.id, notificationType: 'cancellation', recipientType: 'owner' },
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

  return res.status(cancellationCredits.ok ? 200 : 202).json({ success: true, feeCaptured, withinWindow, tier: policy.tier, feePct: policy.feePct, proTripCutCents, rewardsReconciliationRequired: !cancellationCredits.ok, operationalFollowupRequired: !!dispatchCleanupError || !timelineResult.ok });
}
