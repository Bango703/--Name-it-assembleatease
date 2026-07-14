import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit, writeFinancialAuditRequired } from '../_financial-audit.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, computeCancellationFee, computeBookingSplitAtFeePct } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { claimBookingCancellationRecovery, reserveBookingFinancialOperation } from './_financial-operation.js';
import { resolveOrCreateEaserFeeSnapshot } from './_easer-fee-snapshot.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import {
  CANCELLATION_REWARDS_RECONCILIATION_REASON,
  reconcileCancellationAssembleCash,
} from './_cancellation-credits.js';
import { loadBookingRescheduleTruth } from './_cancellation-policy-truth.js';
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
  resolveOwnerCancellationReservation,
} from './_cancellation-operation.js';

async function holdCancellationForReconciliation(sb, booking, operationKey, metadata = {}) {
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
  if (holdError || !heldRows?.length) {
    console.error('Cancellation reconciliation hold failed:', holdError);
    return { ok: false, error: holdError };
  }

  const { error: offersError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
  if (offersError) console.error('Cancellation reconciliation offer cleanup failed:', offersError);

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'cancellation_payment_hold',
    actorType: 'owner',
    actorName: 'Owner',
    description: 'Cancellation paused while Stripe payment or refund state is reconciled',
    metadata,
  });
  return { ok: !offersError, error: offersError || null };
}

async function cancelOpenPaymentIntent(stripe, booking, row) {
  if (row.intent.status === 'canceled') return;
  if (!CANCELLABLE_PAYMENT_INTENT_STATES.has(row.intent.status)) {
    const error = new Error(`Stripe PaymentIntent ${row.paymentIntentId} is in unexpected state ${row.intent.status}.`);
    error.code = 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED';
    throw error;
  }
  const canceled = await stripe.paymentIntents.cancel(
    row.paymentIntentId,
    {},
    { idempotencyKey: `owner-cancel-release-${booking.id}-${row.paymentIntentId}` },
  );
  if (canceled?.status !== 'canceled') {
    const error = new Error(`Stripe did not confirm release of PaymentIntent ${row.paymentIntentId}.`);
    error.code = 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED';
    throw error;
  }
}

export async function fullyRefundCapturedIntent(stripe, {
  booking,
  row,
  reason,
  keyPrefix,
}) {
  const capturedCents = Number(row.intent.amount_received || 0);
  if (row.intent.status !== 'succeeded' || !Number.isInteger(capturedCents) || capturedCents <= 0) {
    return { status: 'not_captured', refundedCents: 0, refundId: null, refund: null };
  }

  const existingPage = await stripe.refunds.list({ payment_intent: row.paymentIntentId, limit: 100 });
  if (existingPage?.has_more) {
    const error = new Error('Stripe returned more refunds than can be safely reconciled in one cancellation.');
    error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
    throw error;
  }
  const existing = existingPage?.data || [];
  const succeeded = existing.filter(refund => refund.status === 'succeeded');
  const pending = existing.filter(refund => !['succeeded', 'failed', 'canceled'].includes(refund.status));
  const succeededCents = succeeded.reduce((total, refund) => total + Number(refund.amount || 0), 0);
  if (!Number.isInteger(succeededCents) || succeededCents < 0 || succeededCents > capturedCents) {
    const error = new Error(`Stripe refund totals do not match PaymentIntent ${row.paymentIntentId}.`);
    error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
    throw error;
  }
  if (pending.length) {
    return {
      status: 'pending',
      refundedCents: succeededCents,
      refundId: pending[0].id,
      refund: pending[0],
    };
  }
  if (succeededCents === capturedCents) {
    return {
      status: 'succeeded',
      refundedCents: succeededCents,
      refundId: succeeded[0]?.id || null,
      refund: succeeded[0] || null,
    };
  }

  const remainingCents = capturedCents - succeededCents;
  const failedAttempts = existing.filter(refund => ['failed', 'canceled'].includes(refund.status)).length;
  const idempotencyKey = `${keyPrefix}-${booking.id}-${row.paymentIntentId}-${remainingCents}-attempt-${failedAttempts + 1}`;
  const refund = await stripe.refunds.create({
    payment_intent: row.paymentIntentId,
    amount: remainingCents,
    metadata: { bookingId: booking.id, bookingRef: booking.ref, reason },
  }, { idempotencyKey });
  if (refund.status !== 'succeeded') {
    return {
      status: ['failed', 'canceled'].includes(refund.status) ? 'failed' : 'pending',
      refundedCents: succeededCents,
      refundId: refund.id,
      refund,
      idempotencyKey,
    };
  }
  const completedCents = succeededCents + Number(refund.amount || 0);
  if (Number(refund.amount || 0) !== remainingCents || completedCents !== capturedCents) {
    const error = new Error(`Stripe did not confirm the complete refund for PaymentIntent ${row.paymentIntentId}.`);
    error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
    throw error;
  }
  return {
    status: 'succeeded',
    refundedCents: completedCents,
    refundId: refund.id,
    refund,
    idempotencyKey,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref, reason } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const cancellationRewardsRecovery = booking.status === BOOKING_STATUS.CANCELLED
    && ['cancel_owner', 'cancel_customer', 'cancel_guest'].includes(booking.financial_operation_type)
    && !!booking.financial_operation_key
    && booking.financial_reconciliation_reason === CANCELLATION_REWARDS_RECONCILIATION_REASON;
  if (cancellationRewardsRecovery) {
    const credits = await reconcileCancellationAssembleCash(
      sb,
      booking,
      'booking_cancel_owner_rewards_recovery',
      booking.financial_operation_key,
    );
    return res.status(credits.ok ? 200 : 202).json({
      success: credits.ok,
      reconciled: credits.ok,
      cancellationAlreadyRecorded: true,
      booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.CANCELLED },
      rewardsReconciliationRequired: !credits.ok,
      message: credits.ok
        ? 'Cancellation rewards were reconciled and the financial hold was released.'
        : 'The cancellation remains recorded, but rewards reconciliation still needs owner attention. No Stripe cancellation or fee action was repeated.',
    });
  }
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });
  if (booking.status === BOOKING_STATUS.IN_PROGRESS || booking.job_started_at) {
    return res.status(409).json({
      error: 'Work has already started. Finish the job payment workflow first, then use the reviewed refund workflow for any customer adjustment. Automatic cancellation fees are disabled after work starts.',
      code: 'WORK_STARTED_CANCELLATION_REVIEW_REQUIRED',
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

  // ── Tiered cancellation fee (% of pre-tax service subtotal, never tax) ────
  const waiveFee = req.body.waiveFee === true;
  let wasRescheduled = false;
  try {
    ({ wasRescheduled } = loadBookingRescheduleTruth(booking));
  } catch (policyTruthError) {
    if (!waiveFee) {
      return res.status(503).json({ error: policyTruthError.message, code: policyTruthError.code });
    }
  }
  const noShow = req.body.noShow === true;   // owner flags a customer no-show → imminent tier
  const policyEvaluationTimeMs = cancellationPolicyEvaluationTimeMs(booking);
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - policyEvaluationTimeMs) / 3600000;
  } catch (dateErr) {
    console.error('Cancellation window date parse error:', dateErr);
  }
  const serviceSubtotalCents = Math.max(0,
    (booking.total_price || 0) - (booking.tax_amount || 0) - (booking.service_call_fee || 0));
  const policy = computeCancellationFee({
    serviceSubtotalCents,
    hoursUntilAppointment: hoursAway,
    status: booking.status,
    isNoShow: noShow,
    forfeitFreeWindow: wasRescheduled,
  });
  const withinCancellationWindow = policy.tier !== 'free';

  let feeSnapshot = null;
  if (policy.proTripCut && booking.assembler_id) {
    try {
      feeSnapshot = await resolveOrCreateEaserFeeSnapshot(sb, booking, booking.assembler_id);
    } catch (feeError) {
      console.error('Owner cancellation fee snapshot error:', feeError);
      return res.status(503).json({ error: feeError.message, code: feeError.code });
    }
  }

  // ── Stripe: charge fee or release hold ────────────────────────────────────
  let refundAmount = 0;
  let refundId = null;
  let feeCaptured = 0;
  let proTripCutCents = 0;
  if (booking.payment_status === 'cancellation_fee_captured') {
    feeCaptured = Number(booking.cancellation_fee || booking.amount_charged || 0);
  }
  const linkedIntentIds = bookingCancellationPaymentIntentIds(booking);
  const paymentStateRequiresIntent = ['authorized', 'captured', 'partially_refunded', 'deposit_paid'].includes(booking.payment_status);
  if (paymentStateRequiresIntent && !linkedIntentIds.length) {
    return res.status(409).json({
      error: 'The booking payment record is missing its Stripe PaymentIntent. Nothing was cancelled.',
      code: 'CANCELLATION_PAYMENT_INTENT_MISSING',
    });
  }
  if (linkedIntentIds.length && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is unavailable. The booking was not cancelled because payment state could not be reconciled.' });
  }
  let reservation;
  try {
    reservation = resolveOwnerCancellationReservation(booking);
  } catch (reservationError) {
    return res.status(409).json({ error: reservationError.message, code: reservationError.code });
  }
  const { operationKey, operationType, takeover, expectedOperationKey } = reservation;
  try {
    if (takeover) {
      await claimBookingCancellationRecovery(sb, {
        booking,
        expectedOperationKey,
        ownerOperationKey: operationKey,
      });
    } else {
      await reserveBookingFinancialOperation(sb, {
        bookingId: booking.id,
        operationKey,
        operationType,
        expectedStatuses: [booking.status],
        expectedAssemblerId: booking.assembler_id || null,
        expectedDate: booking.date,
        expectedTime: booking.time,
        checkAppointment: true,
        expectedBooking: booking,
      });
    }
  } catch (reservationError) {
    return res.status(reservationError.code === 'FINANCIAL_OPERATION_CONFLICT' ? 409 : 503).json({
      error: reservationError.message,
      code: reservationError.code,
    });
  }
  if (linkedIntentIds.length) {
    let stripeMutationStarted = false;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const linkedIntents = await loadBookingCancellationPaymentIntents(stripe, booking);
      const invalidSucceededIntent = linkedIntents.find(row => row.intent.status === 'succeeded'
        && (!Number.isInteger(Number(row.intent.amount_received)) || Number(row.intent.amount_received) <= 0));
      if (invalidSucceededIntent) {
        for (const row of linkedIntents.filter(item => CANCELLABLE_PAYMENT_INTENT_STATES.has(item.intent.status))) {
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, row);
        }
        const error = new Error(`Stripe PaymentIntent ${invalidSucceededIntent.paymentIntentId} has invalid captured totals.`);
        error.code = 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED';
        throw error;
      }
      const unexpectedIntent = linkedIntents.find(row => row.intent.status !== 'succeeded'
        && row.intent.status !== 'canceled'
        && !CANCELLABLE_PAYMENT_INTENT_STATES.has(row.intent.status));
      if (unexpectedIntent) {
        for (const row of linkedIntents.filter(item => CANCELLABLE_PAYMENT_INTENT_STATES.has(item.intent.status))) {
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, row);
        }
        const error = new Error(`Stripe PaymentIntent ${unexpectedIntent.paymentIntentId} is in unexpected state ${unexpectedIntent.intent.status}.`);
        error.code = 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED';
        throw error;
      }

      const capturedRows = linkedIntents.filter(row => row.intent.status === 'succeeded');
      const feeRecoveryRow = capturedRows.length === 1 ? capturedRows[0] : null;
      const expectedRecoveredFee = feeRecoveryRow && !waiveFee
        ? policy.feeCents
        : 0;
      const feeRecoveryMatchesStripe = feeRecoveryRow
        && ['authorized', 'pending', 'failed', 'not_required'].includes(booking.payment_status)
        && isUnrefundedCancellationFeeCapture(feeRecoveryRow, booking, expectedRecoveredFee);
      const canRecoverCancellationFee = feeRecoveryMatchesStripe
        && await hasDurableCancellationFeeCaptureAudit(sb, {
          booking,
          paymentIntentId: feeRecoveryRow.paymentIntentId,
          feeCents: expectedRecoveredFee,
        });

      if (capturedRows.length && !canRecoverCancellationFee) {
        // Release every other live authorization before refunding captured
        // charges so a stale database state cannot leave a second hold behind.
        for (const row of linkedIntents.filter(item => item.intent.status !== 'succeeded' && item.intent.status !== 'canceled')) {
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, row);
        }

        let fullyRefundedCents = 0;
        for (const row of capturedRows) {
          stripeMutationStarted = true;
          const result = await fullyRefundCapturedIntent(stripe, {
            booking,
            row,
            reason: 'owner_cancelled_post_capture',
            keyPrefix: 'owner-cancel-refund',
          });
          refundId = result.refundId || refundId;
          await writeFinancialAuditRequired(sb, {
            eventType: 'refund_attempt',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: row.paymentIntentId,
            refundId: result.refundId,
            idempotencyKey: result.idempotencyKey,
            status: result.status === 'succeeded' ? 'processed' : (result.status === 'pending' ? 'processing' : 'failed'),
            metadata: {
              reason: 'owner_cancelled_post_capture',
              succeededRefundCents: result.refundedCents,
              stripeRefundStatus: result.refund?.status || result.status,
            },
          });
          if (result.status !== 'succeeded') {
            const held = await holdCancellationForReconciliation(sb, booking, operationKey, {
              code: result.status === 'pending' ? 'CANCELLATION_REFUND_PENDING' : 'CANCELLATION_REFUND_FAILED',
              paymentIntentId: row.paymentIntentId,
              refundId: result.refundId,
              stripeRefundStatus: result.refund?.status || result.status,
            });
            return res.status(result.status === 'pending' && held.ok ? 202 : 503).json({
              success: false,
              recoverable: true,
              pending: result.status === 'pending',
              code: result.status === 'pending' ? 'CANCELLATION_REFUND_PENDING' : 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED',
              error: result.status === 'pending'
                ? 'Stripe is still processing the refund. Dispatch is paused and the booking has not been marked cancelled. Retry this same cancellation after Stripe settles.'
                : 'Stripe did not complete every required refund. Dispatch is paused and the booking remains locked for reconciliation.',
              refundId: result.refundId,
            });
          }
          fullyRefundedCents += result.refundedCents;
        }
        if (Number(booking.refund_amount || 0) > fullyRefundedCents) {
          const error = new Error('The database refund total exceeds succeeded Stripe refunds.');
          error.code = 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED';
          throw error;
        }
        refundAmount = fullyRefundedCents;
      } else if (canRecoverCancellationFee) {
        for (const row of linkedIntents.filter(item => item !== feeRecoveryRow && item.intent.status !== 'canceled')) {
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, row);
        }
        feeCaptured = Number(feeRecoveryRow.intent.amount_received);
      } else {
        const primaryRow = linkedIntents.find(row => row.paymentIntentId === booking.stripe_payment_intent_id)
          || linkedIntents.find(row => row.paymentIntentId === booking.stripe_deposit_intent_id)
          || linkedIntents[0];
        const feeRow = primaryRow?.intent.status === 'requires_capture'
          && ['customer_booking', 'customer_quote', 'reauth'].includes(primaryRow.intent.metadata?.type)
          ? primaryRow
          : null;

        // Release any extra live intents before the one canonical fee capture.
        for (const row of linkedIntents) {
          if (row === feeRow || row.intent.status === 'canceled') continue;
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, row);
        }

        if (feeRow && !waiveFee && policy.feeCents > 0) {
          if (feeRow.intent.capture_method !== 'manual'
              || Number(feeRow.intent.amount || 0) !== Number(booking.total_price || 0)
              || !Number.isInteger(Number(feeRow.intent.amount_capturable))
              || Number(feeRow.intent.amount_capturable) < policy.feeCents) {
            stripeMutationStarted = true;
            await cancelOpenPaymentIntent(stripe, booking, feeRow);
            const error = new Error('Stripe authorization amount or capture method does not match the server-priced booking.');
            error.code = 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED';
            throw error;
          }
          const feeCents = policy.feeCents;
          const idempotencyKey = `owner-cancel-fee-${booking.id}-${feeCents}`;
          stripeMutationStarted = true;
          const captured = await stripe.paymentIntents.capture(feeRow.paymentIntentId, {
            amount_to_capture: feeCents,
          }, { idempotencyKey });
          if (captured?.status !== 'succeeded' || Number(captured.amount_received || 0) !== feeCents) {
            const error = new Error('Stripe did not confirm the exact cancellation fee capture.');
            error.code = 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED';
            throw error;
          }
          feeCaptured = feeCents;
          await writeFinancialAuditRequired(sb, {
            eventType: 'capture_attempt',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: feeRow.paymentIntentId,
            idempotencyKey,
            status: 'processed',
            metadata: { reason: noShow ? 'owner_no_show_fee' : 'owner_cancel_fee', feeCaptured, tier: policy.tier, feePct: policy.feePct },
          });
        } else if (feeRow) {
          stripeMutationStarted = true;
          await cancelOpenPaymentIntent(stripe, booking, feeRow);
          await writeFinancialAuditRequired(sb, {
            eventType: 'capture_release',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: feeRow.paymentIntentId,
            idempotencyKey: `owner-cancel-release-${booking.id}-${feeRow.paymentIntentId}`,
            status: 'processed',
            metadata: { reason: 'owner_cancel_release' },
          });
        }
      }
    } catch (stripeErr) {
      console.error('Stripe cancel/refund error:', stripeErr);
      await writeFinancialAudit(sb, {
        eventType: 'booking_cancel_financial',
        eventSource: 'booking_cancel_owner',
        bookingId: booking.id,
        paymentIntentId: booking.stripe_payment_intent_id,
        status: 'failed',
        metadata: { reason: reason || null, paymentStatus: booking.payment_status },
        error: stripeErr?.message || 'Owner cancellation Stripe mutation failed',
      });
      const held = await holdCancellationForReconciliation(sb, booking, operationKey, {
        code: stripeErr?.code || 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED',
        stripeMutationStarted,
      });
      return res.status(held.ok ? 409 : 503).json({
        success: false,
        recoverable: true,
        code: stripeErr?.code || 'CANCELLATION_PAYMENT_RECONCILIATION_REQUIRED',
        error: 'Stripe could not be fully reconciled. Dispatch is paused and the booking was not marked cancelled. Retry this same owner cancellation after reviewing Stripe.',
      });
    }
  }

  // Pro trip cut for no-show / en-route cancellations — recorded for manual payout.
  if (feeCaptured > 0 && policy.proTripCut && booking.assembler_id) {
    proTripCutCents = computeBookingSplitAtFeePct(feeCaptured, feeSnapshot.feePct, { taxCents: 0 }).assemblerDueCents;
  }

  let paymentStatus = booking.payment_status;
  if (refundAmount > 0) paymentStatus = 'refunded';
  else if (feeCaptured > 0) paymentStatus = 'cancellation_fee_captured';
  else if (linkedIntentIds.length) paymentStatus = 'authorization_released';
  const releasedWithoutCharge = linkedIntentIds.length > 0 && refundAmount === 0 && feeCaptured === 0;

  const cumulativeRefund = refundAmount > 0 ? refundAmount : Number(booking.refund_amount || 0);
  const cancellationUpdate = {
    status: BOOKING_STATUS.CANCELLED,
    cancelled_at: new Date().toISOString(),
    cancel_reason: reason || null,
    cancellation_fee: feeCaptured || null,
    payment_status: paymentStatus,
    amount_charged: feeCaptured > 0 ? feeCaptured : (releasedWithoutCharge ? null : booking.amount_charged),
    payment_captured_at: feeCaptured > 0 ? new Date().toISOString() : (releasedWithoutCharge ? null : booking.payment_captured_at),
    refund_amount: cumulativeRefund,
    refund_id: refundId || booking.refund_id,
    refunded_at: refundAmount > 0 ? new Date().toISOString() : booking.refunded_at,
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
    .eq('financial_operation_type', operationType);
  updateQuery = booking.assembler_id
    ? updateQuery.eq('assembler_id', booking.assembler_id)
    : updateQuery.is('assembler_id', null);
  const { error: updateErr, data: updatedRows } = await updateQuery.select('id');

  if (updateErr || !updatedRows?.length) {
    console.error('Cancel update error:', updateErr);
    await holdCancellationForReconciliation(sb, booking, operationKey, {
      code: 'CANCELLATION_FINALIZE_FAILED',
      stripeReconciled: true,
    });
    return res.status(500).json({
      error: 'Stripe was reconciled, but the booking cancellation could not be finalized. Retry this same owner cancellation before taking another action.',
      code: 'CANCELLATION_FINALIZE_FAILED',
    });
  }

  const cancellationCredits = await reconcileCancellationAssembleCash(sb, booking, 'booking_cancel_owner', operationKey);

  // Cancel all open dispatch offers so Easers cannot accept a cancelled booking
  const { error: dispatchCleanupError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
  if (dispatchCleanupError) console.error('dispatch_offers cancel cleanup error:', dispatchCleanupError.message);

  // Release the assigned Easer's daily job slot (if one was assigned)
  if (booking.assembler_id) {
    await adjustActiveJobs(sb, booking.assembler_id, -1);
  }

  // Send cancellation email to customer
  try {
    const reasonHtml = reason
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
           <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a">Reason</p>
           <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.6">${esc(reason)}</p>
         </td></tr></table>`
      : '';

    const refundHtml = refundAmount > 0
      ? `<p style="margin:0 0 20px;font-size:14px;color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;">
           A full refund of <strong>$${(refundAmount / 100).toFixed(2)}</strong> has been processed and will appear on your card within 5&ndash;10 business days.
         </p>`
      : '';

    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 20px;font-size:14px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;">
           A cancellation fee of <strong>$${(feeCaptured / 100).toFixed(2)}</strong> (${policy.feePct}% of the service subtotal &mdash; no tax) was charged per our cancellation policy. The remainder of your hold has been released.
         </p>`
      : '';

    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'CANCELLED',
      statusColor: '#71717a',
      statusBg: '#f4f4f5',
      headline: `Your booking has been cancelled, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your booking for <strong>${esc(booking.service)}</strong> on <strong>${esc(booking.date)}</strong> has been cancelled.</p>
        ${refundHtml}
        ${feeHtml}
        ${reasonHtml}
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">If you'd like to rebook or have any questions, please don't hesitate to reach out.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Booking Cancelled — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'cancellation', recipientType: 'customer' },
    });
  } catch (emailErr) {
    console.error('Cancel email error:', emailErr);
  }

  const timelineResult = await logActivity(sb, { bookingId: booking.id, eventType: 'cancelled', actorType: 'owner', actorName: 'Owner', description: `Booking cancelled${reason ? ': ' + reason : ''}${feeCaptured ? ' (fee charged: $' + (feeCaptured/100).toFixed(2) + ', ' + policy.feePct + '% ' + policy.tier + ')' : ''}${proTripCutCents ? ' (pro trip cut owed: $' + (proTripCutCents/100).toFixed(2) + ')' : ''}${refundAmount ? ' (refunded: $' + (refundAmount/100).toFixed(2) + ')' : ''}`, metadata: { reason, feeCaptured, refundAmount, tier: policy.tier, feePct: policy.feePct, proTripCutCents, ownerRecoveryTakeover: takeover } });
  const operationalFollowupRequired = !!dispatchCleanupError || !timelineResult.ok;

  return res.status(cancellationCredits.ok ? 200 : 202).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.CANCELLED }, refundAmount, feeCaptured, withinCancellationWindow, tier: policy.tier, feePct: policy.feePct, proTripCutCents, rewardsReconciliationRequired: !cancellationCredits.ok, operationalFollowupRequired });
}
