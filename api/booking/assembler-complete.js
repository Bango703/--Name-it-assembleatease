import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc, buildReviewCta } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES, computeBookingSplitFromSnapshot } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { evaluateEaserAppointmentGate } from './_appointment-gates.js';
import { loadCurrentCompletionEvidence } from './_completion-evidence.js';
import {
  releaseBookingFinancialOperation,
  reserveBookingFinancialOperation,
} from './_financial-operation.js';
import { finalizeCompletionRewards, surfaceCompletionRewardHold } from './_completion-rewards.js';
import { resolveOrCreateEaserFeeSnapshot } from './_easer-fee-snapshot.js';
import { captureOrRecoverBookingPayment } from './_stripe-booking-payment.js';
import { offlineMethodFeeCents } from '../owner/_offline-payment.js';
import { isOwnerManualLiveFlow } from '../_owner-easer.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/booking/assembler-complete
 * The assigned assembler marks a job as done.
 * Requires Bearer JWT (assembler session token).
 * Body: { bookingId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  const access = await requireAssignedWorkEaser(req, { supabase: sb });
  if (!access.ok) return respondWithEaserAccessError(res, access);
  const { user, profile } = access;

  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  // Fetch booking
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Verify this assembler is assigned
  if (booking.assembler_id !== user.id) {
    return res.status(403).json({ error: 'You are not assigned to this booking' });
  }
  const operationKey = `complete:${booking.id}`;
  const offlineOwnerEaserLiveFlow = isOwnerManualLiveFlow(booking, profile);
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    if (offlineOwnerEaserLiveFlow) {
      return res.status(200).json({
        success: true,
        alreadyCompleted: true,
        offline: true,
        booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
        payout: booking.payout_status === 'paid'
          ? { status: 'paid' }
          : { status: booking.payment_collected ? 'pending_manual' : 'on_hold_customer_collection' },
      });
    }
    if (booking.payment_status === 'captured'
        && booking.financial_operation_key === operationKey
        && ['completion_owner', 'completion_easer'].includes(booking.financial_operation_type)) {
      const rewardResult = await finalizeCompletionRewards(sb, {
        booking,
        operationKey,
        amountChargedCents: booking.amount_charged || booking.total_price,
      });
      if (!rewardResult.ok) {
        await surfaceCompletionRewardHold(sb, booking, operationKey, rewardResult, {
          actorType: 'easer', actorId: user.id, actorName: booking.assembler_name || 'Easer',
          eventSource: 'booking_complete_assembler_retry',
        });
      }
      return res.status(rewardResult.ok ? 200 : 202).json({
        success: true,
        alreadyCompleted: true,
        reconciliationRequired: !rewardResult.ok,
        code: rewardResult.ok ? undefined : rewardResult.code,
        booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
      });
    }
    return res.status(400).json({ error: 'Booking is already marked complete' });
  }
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    return res.status(400).json({ error: 'Job must be active to mark complete' });
  }
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.COMPLETED);
  if (transitionErr) {
    return res.status(400).json({ error: transitionErr });
  }
  if (!booking.assembler_accepted_at) {
    return res.status(409).json({ error: 'You must explicitly accept this job before it can be completed.' });
  }

  const appointmentGate = evaluateEaserAppointmentGate({
    date: booking.return_visit_required ? booking.return_visit_date : booking.date,
    time: booking.return_visit_required ? booking.return_visit_time : booking.time,
    stage: 'completed',
  });
  if (!appointmentGate.allowed) return res.status(409).json(appointmentGate);

  // Completion truth is a photo uploaded by the current assigned Easer after
  // this assignment entered in_progress. Before/damage evidence never qualifies.
  const completionEvidenceResult = await loadCurrentCompletionEvidence(sb, booking);
  if (completionEvidenceResult.error) {
    console.error('Completion evidence lookup failed:', completionEvidenceResult.error);
    return res.status(503).json({ error: 'Completion evidence could not be verified. No payment was captured.' });
  }
  const completionEvidence = completionEvidenceResult.evidence;
  if (!completionEvidence) {
    return res.status(400).json({ error: 'A completion photo is required. Please upload a photo before marking this job complete.' });
  }

  // Offline owner-manual completion: the owner's own Easer account finishing an
  // offline job it worked live. There is no Stripe capture — collection is a
  // separate owner-audited step — so this path computes the split, records the
  // manual payout obligation, and skips every Stripe capture gate below.
  if (offlineOwnerEaserLiveFlow) {
    if (booking.stripe_payment_intent_id
        || booking.stripe_deposit_intent_id
        || booking.stripe_balance_payment_intent_id) {
      return res.status(409).json({
        error: 'This offline booking unexpectedly has linked Stripe payment state. Owner reconciliation is required before completion.',
        code: 'OFFLINE_STRIPE_STATE_CONFLICT',
      });
    }
    return await completeOfflineOwnerManualBooking(sb, res, {
      booking,
      user,
      completionEvidence,
      operationKey,
    });
  }

  const positivePrice = Number(booking.total_price || 0) > 0;
  if (!positivePrice) {
    return res.status(409).json({
      error: 'This job cannot be completed until the owner confirms a positive final price.',
      code: 'PRICE_NOT_SET',
    });
  }
  const capturedRecovery = booking.payment_status === 'captured';
  if (positivePrice && !['authorized', 'deposit_paid', 'captured'].includes(booking.payment_status)) {
    return res.status(409).json({
      error: 'Customer payment is not authorized. The job cannot be completed and no earnings will be created until the owner resolves payment.',
      code: 'PAYMENT_NOT_AUTHORIZED',
    });
  }

  // Block positive-price completion if no Stripe source exists.
  if (positivePrice && !booking.stripe_payment_intent_id && !booking.stripe_deposit_intent_id) {
    if (!booking.stripe_payment_method_id) {
      return res.status(400).json({
        error: 'No payment method on file. Contact AssembleAtEase to resolve before completing.',
        code: 'PAYMENT_NOT_AUTHORIZED',
      });
    }
    return res.status(400).json({
      error: 'This is a custom quote job. The owner must finalize the quote price before you can mark it complete.',
      code: 'QUOTE_PENDING_APPROVAL',
    });
  }

  const captureRequired = booking.payment_status === 'authorized' || booking.payment_status === 'deposit_paid';
  if ((captureRequired || capturedRecovery) && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Payment capture configuration is unavailable. Booking was not completed.',
      code: 'CAPTURE_CONFIGURATION_UNAVAILABLE',
    });
  }

  let feeSnapshot;
  try {
    feeSnapshot = await resolveOrCreateEaserFeeSnapshot(sb, booking, user.id);
  } catch (feeError) {
    console.error('Assembler-complete fee snapshot error:', feeError);
    return res.status(503).json({ error: feeError.message, code: feeError.code });
  }

  // Shared with owner completion so either trusted actor can reconcile an
  // ambiguous Stripe success using the same idempotent financial reservation.
  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: 'completion_easer',
      expectedStatuses: [BOOKING_STATUS.IN_PROGRESS],
      expectedAssemblerId: user.id,
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

  let amountCharged = 0;
  let actualStripeFee = null;
  let balancePaymentIntentId = booking.stripe_balance_payment_intent_id || null;
  let balanceAmountCaptured = booking.stripe_balance_amount_captured ?? null;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const paymentResult = await captureOrRecoverBookingPayment({
        stripe: new Stripe(process.env.STRIPE_SECRET_KEY),
        sb,
        booking,
        eventSource: 'booking_complete_assembler',
      });
      amountCharged = paymentResult.amountCharged;
      actualStripeFee = paymentResult.actualStripeFee;
      balancePaymentIntentId = paymentResult.balancePaymentIntentId;
      balanceAmountCaptured = paymentResult.balanceAmountCaptured;
    } catch (stripeErr) {
      console.error('Assembler-complete Stripe capture error:', stripeErr);
      await writeFinancialAudit(sb, {
        eventType: 'capture_attempt',
        eventSource: 'booking_complete_assembler',
        bookingId: booking.id,
        paymentIntentId: booking.stripe_payment_intent_id,
        status: 'failed',
        metadata: { ref: booking.ref, paymentStatus: booking.payment_status },
        error: stripeErr?.message || 'Unknown Stripe capture error',
      });

      logActivity(sb, {
        bookingId: booking.id,
        eventType: 'capture_failed',
        actorType: 'easer',
        actorId: user.id,
        actorName: booking.assembler_name || 'Easer',
        description: `Payment capture failed during assembler completion: ${stripeErr?.message || 'Unknown Stripe error'}`,
        metadata: { paymentStatus: booking.payment_status, paymentIntentId: booking.stripe_payment_intent_id || null },
      });

      try {
        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Payment Capture Failed - ${booking.ref}`,
          html: `<p>Payment capture failed while the Easer attempted to complete booking <strong>${esc(booking.ref)}</strong>. The booking was not marked complete and no Easer earnings were created.</p>
<p>Customer: ${esc(booking.customer_name)} | Error: ${esc(stripeErr?.message)}</p>
<p>Manual resolution required in Stripe dashboard.</p>`,
        });
      } catch (e) { console.error('Capture failure alert error:', e); }

      // Detect expired/uncapturable PI and give a clearer message
      const isUncapturable = stripeErr?.code === 'payment_intent_unexpected_state'
        || (stripeErr?.message || '').includes('requires_payment_method')
        || (stripeErr?.message || '').includes('requires_capture');
      return res.status(502).json({
        error: isUncapturable
          ? 'The card authorization for this job has expired or is no longer valid. The owner has been notified and will collect payment manually. You can message support if you need help.'
          : 'Payment capture failed. The owner has been alerted and will resolve this. Please message support if you need assistance.',
        code: 'CAPTURE_FAILED',
      });
    }
  }

  if (captureRequired && amountCharged <= 0) {
    return res.status(502).json({
      error: 'Payment capture did not produce a charge. Booking was not completed.',
      code: 'CAPTURE_INCOMPLETE',
    });
  }

  const finalAmount = captureRequired ? amountCharged : (amountCharged || booking.total_price || 0);

  if (!captureRequired && finalAmount <= 0) {
    return res.status(400).json({
      error: 'This job can\'t be marked complete yet — the final price hasn\'t been confirmed. Contact your dispatcher.',
      code: 'PRICE_NOT_SET',
    });
  }

  // Canonical money split — tax is a pass-through liability and is EXCLUDED from
  // the fee/payout base. AssembleCash is funded by platform margin, so it must
  // never reduce the Easer's payout basis.
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: finalAmount,
    taxCents: booking.tax_amount || 0,
    feePct: feeSnapshot.feePct,
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  const PLATFORM_FEE_PCT = split.feePct;
  const platformFee      = split.platformFeeCents;
  const assemblerDue     = split.assemblerDueCents;
  const taxCents         = split.taxCents;
  const payoutBaseCents  = split.payoutBaseCents;
  const assemblecashRedeemedCents = split.assemblecashRedeemedCents;
  let connectPayout = { status: 'disabled' };

  // ── Update booking (atomic guard — prevents double-complete race) ────────
  const completionPayload = {
    status: BOOKING_STATUS.COMPLETED,
    completed_at: new Date().toISOString(),
    payment_status: 'captured',
    payment_captured_at: new Date().toISOString(),
    amount_charged: finalAmount,
    platform_fee_pct: PLATFORM_FEE_PCT,
    platform_fee: platformFee,
    assembler_due: assemblerDue,
    completed_by: 'assembler',
    payout_status: assemblerDue > 0 ? 'pending' : null,
    payout_mode_snapshot: assemblerDue > 0
      ? (isStripeConnectEnabled() ? 'stripe_connect' : 'manual')
      : null,
    payout_review_status: 'not_required',
    stripe_balance_payment_intent_id: balancePaymentIntentId,
    stripe_balance_amount_captured: balanceAmountCaptured,
    financial_reconciliation_required_at: null,
    financial_reconciliation_reason: null,
  };
  if (actualStripeFee != null) completionPayload.stripe_fee = actualStripeFee;
  const completionUpdate = sb.from('bookings').update(completionPayload)
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.IN_PROGRESS)
    .eq('assembler_id', user.id)
    .eq('financial_operation_key', operationKey);
  const { error: updateErr, data: updatedRows } = await completionUpdate.select('id');

  if (updateErr) {
    console.error('Assembler-complete update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }
  if (!updatedRows || updatedRows.length === 0) {
    const { data: current } = await sb
      .from('bookings')
      .select('*')
      .eq('id', booking.id)
      .maybeSingle();

    if (current?.status === BOOKING_STATUS.COMPLETED && current?.payment_status === 'captured') {
      let recoveryResult = { ok: true };
      if (current.financial_operation_key === operationKey
          && ['completion_owner', 'completion_easer'].includes(current.financial_operation_type)) {
        recoveryResult = await finalizeCompletionRewards(sb, {
          booking: current,
          operationKey,
          amountChargedCents: current.amount_charged || current.total_price,
        });
        if (!recoveryResult.ok) {
          await surfaceCompletionRewardHold(sb, current, operationKey, recoveryResult, {
            actorType: 'easer', actorId: user.id, actorName: current.assembler_name || 'Easer',
            eventSource: 'booking_complete_assembler_race_recovery',
          });
        }
      }
      return res.status(recoveryResult.ok ? 200 : 202).json({
        success: true,
        alreadyCompleted: true,
        reconciliationRequired: !recoveryResult.ok,
        code: recoveryResult.ok ? undefined : recoveryResult.code,
        booking: { id: booking.id, ref: booking.ref, status: current.status || BOOKING_STATUS.COMPLETED },
        payout: current.stripe_transfer_id
          ? {
              status: current.payout_status === 'paid' ? 'paid' : 'pending_manual',
              transferId: current.stripe_transfer_id,
              destinationAccount: current.stripe_destination_account_id || null,
            }
          : { status: current.payout_status === 'paid' ? 'paid' : 'pending_manual' },
      });
    }

    return res.status(409).json({
      error: 'Completion capture succeeded, but booking state was changed by another request. Contact AssembleAtEase before retrying.',
      code: 'COMPLETION_STATE_RACE',
    });
  }

  // Keep the exact completion reservation until both canonical reward records
  // are verified. Ambiguity leaves the booking locked and visible in Live Ops.
  const rewardResult = await finalizeCompletionRewards(sb, {
    booking: {
      ...booking,
      status: BOOKING_STATUS.COMPLETED,
      payment_status: 'captured',
      amount_charged: finalAmount,
    },
    operationKey,
    amountChargedCents: finalAmount,
  });
  if (!rewardResult.ok) {
    await surfaceCompletionRewardHold(sb, booking, operationKey, rewardResult, {
      actorType: 'easer', actorId: user.id, actorName: booking.assembler_name || 'Easer',
      eventSource: 'booking_complete_assembler',
    });
  }

  // Payout is HELD, not sent now. A 'release-payouts' cron transfers it via Stripe
  // Connect ~48h after completion. That hold (a) gives a dispute/verification window
  // and (b) lets the just-captured funds settle from pending -> available, since
  // Stripe transfers require AVAILABLE balance (an immediate transfer fails otherwise).
  // The booking is already payout_status='pending' (set above); the cron does the rest.
  if (isStripeConnectEnabled() && assemblerDue > 0) {
    connectPayout = { status: 'scheduled', note: 'Releases ~48h after completion (dispute window + funds settling).' };
  } else if (assemblerDue > 0) {
    connectPayout = { status: 'pending_manual', reason: 'connect-disabled' };
  }

  // ── Increment completed_jobs + total_earned atomically ──────────────────────
  try {
    const { error: rpcErr } = await sb.rpc('increment_profile_counters', { user_id: user.id, earned_cents: assemblerDue });
    if (rpcErr) console.error('profile counters RPC failed — counter may need reconciliation:', rpcErr.message);
  } catch (e) { console.error('profile counters increment error:', e); }

  // Job is done — release the Easer's daily slot
  adjustActiveJobs(sb, user.id, -1).catch(() => {});

  // ── Email customer receipt ───────────────────────────────────────────────
  try {
    const amountDisplay = finalAmount > 0 ? `$${(finalAmount / 100).toFixed(2)}` : null;

    // Completion photo — visual proof of the finished work (signed URL, 30-day expiry).
    let photoBlock = '';
    try {
      const path = completionEvidence.storage_path;
      if (path) {
        const { data: signed } = await sb.storage.from('booking-evidence').createSignedUrl(path, 60 * 60 * 24 * 30);
        if (signed?.signedUrl) {
          photoBlock = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td>
            <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">Here's a photo of the finished work:</p>
            <img src="${signed.signedUrl}" alt="Completed ${esc(booking.service)}" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e4e4e7;display:block"/>
          </td></tr></table>`;
        }
      }
    } catch (photoErr) { console.error('Completion photo signed-url error:', photoErr.message); }
    const receiptBlock = amountDisplay ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payment Receipt</p>
        <p style="margin:0 0 12px;font-size:28px;font-weight:700;color:#065f46">${amountDisplay}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#166534">
          <tr><td style="padding:3px 0;width:130px">Service</td><td style="padding:3px 0;font-weight:600">${esc(booking.service)}</td></tr>
          <tr><td style="padding:3px 0">Reference</td><td style="padding:3px 0;font-weight:600">${esc(booking.ref)}</td></tr>
          <tr><td style="padding:3px 0">Status</td><td style="padding:3px 0;font-weight:700">Charged</td></tr>
        </table>
      </td></tr></table>` : '';

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Job Complete & Payment Receipt — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: 'COMPLETED',
        statusColor: '#065f46',
        statusBg: '#d1fae5',
        headline: `Your job is complete, ${esc((booking.customer_name || '').split(' ')[0])}.`,
        bodyHtml: `
          <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> has been completed. Thank you for choosing AssembleAtEase!</p>
          ${photoBlock}
          ${receiptBlock}
          ${buildReviewCta()}
          <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions about the completed work or receipt? Reply to this email and the owner will follow up.</p>`,
      }),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Assembler-complete customer email error:', e); }

  // ── Email assembler their payout breakdown ───────────────────────────────
  try {
    const { data: asmProfile } = await sb.from('profiles').select('full_name, email').eq('id', user.id).single();
    if (asmProfile?.email && finalAmount > 0) {
      await sendEmail({
        to: asmProfile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Job complete — here's what you earned (${booking.ref})`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:20px;font-weight:700;color:#065f46">&#10003; Job Marked Complete</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b">Booking <strong>${esc(booking.ref)}</strong> &mdash; ${esc(booking.service)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:16px"><tr><td style="padding:16px 20px">
      <table width="100%" style="font-size:14px">
        <tr><td style="padding:4px 0;color:#166534">Total charged to customer</td><td style="padding:4px 0;text-align:right;font-weight:600">$${(finalAmount/100).toFixed(2)}</td></tr>
        ${taxCents > 0 ? `<tr><td style="padding:4px 0;color:#166534">Sales tax (paid to the state)</td><td style="padding:4px 0;text-align:right;color:#71717a">&minus;$${(taxCents/100).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0;color:#166534">Pre-tax amount collected</td><td style="padding:4px 0;text-align:right;font-weight:600">$${((finalAmount - taxCents)/100).toFixed(2)}</td></tr>` : ''}
        ${assemblecashRedeemedCents > 0 ? `<tr><td style="padding:4px 0;color:#166534">AssembleCash funded by AssembleAtEase</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0f766e">+$${(assemblecashRedeemedCents/100).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0;color:#166534">Payout basis before platform share</td><td style="padding:4px 0;text-align:right;font-weight:600">$${(payoutBaseCents/100).toFixed(2)}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:#166534">${assemblecashRedeemedCents > 0 ? 'Platform share after customer credit' : `Platform fee (${PLATFORM_FEE_PCT}% of service amount)`}</td><td style="padding:4px 0;text-align:right;color:#dc2626">&minus;$${(platformFee/100).toFixed(2)}</td></tr>
        <tr style="border-top:1px solid #bbf7d0"><td style="padding:8px 0 4px;font-weight:700;color:#065f46">Your payout</td><td style="padding:8px 0 4px;text-align:right;font-weight:700;color:#065f46;font-size:18px">$${(assemblerDue/100).toFixed(2)}</td></tr>
      </table>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;margin-bottom:14px"><tr><td style="padding:12px 16px;font-size:13px;color:#0c4a6e;line-height:1.6">
      ${isStripeConnectEnabled() ? "Your payout releases to your bank <strong>about 48 hours after completion</strong>, once the job is confirmed and clear of any dispute. You'll see it move from <em>Pending</em> to <em>Paid</em> on your Payouts page." : "Your payout for this job is now <strong>pending</strong>. AssembleAtEase sends Easer payouts by bank transfer (ACH) once the job is confirmed and clear of any dispute &mdash; typically within a few business days. You'll see it move from <em>Pending</em> to <em>Paid</em> on your Payouts page, and you'll get a payout confirmation email when it's sent."}
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Contact <a href="mailto:${ownerEmail()}" style="color:#00BFFF">${ownerEmail()}</a>.</p>
  </td></tr></table>
</div></body></html>`,
      });
    }
  } catch (e) { console.error('Assembler payout email error:', e); }

  // ── Notify owner ─────────────────────────────────────────────────────────
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Job Completed by Easer — ${booking.ref}`,
      html: `<p>Booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}) has been marked complete by the Easer.</p>
<p>Customer: ${esc(booking.customer_name)} | Amount: $${(finalAmount/100).toFixed(2)} | Easer due: $${(assemblerDue/100).toFixed(2)}</p>`,
    });
  } catch (e) { console.error('Owner notify error:', e); }

  // Activity log (surfaces in owner Timeline tab)
  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'completed',
    actorType: 'easer',
    actorId: user.id,
    actorName: booking.assembler_name || 'Easer',
    description: `Job marked complete by Easer. Amount charged: $${(finalAmount / 100).toFixed(2)}. Easer due: $${(assemblerDue / 100).toFixed(2)}`,
    metadata: { amountCharged: finalAmount, platformFee, assemblerDue, platformFeePct: PLATFORM_FEE_PCT },
  });

  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedwon').catch(e => console.error('HubSpot error:', e));
  }

  return res.status(rewardResult.ok ? 200 : 202).json({
    success: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
    payout: connectPayout,
    reconciliationRequired: !rewardResult.ok,
    code: rewardResult.ok ? undefined : rewardResult.code,
  });
}

// Completion for an offline (owner_manual) job the owner worked with their own
// Easer account. No Stripe capture happens — the customer paid the owner offline
// — so this is fully self-contained: it computes the canonical split, records the
// Easer payout as pending (owner pays and records it like any regular job), and
// notifies the customer with the same branded completion email as a dispatched
// job. payment_status stays 'offline_recorded' and is NEVER set to 'captured':
// no funds sit in Stripe. Reached only for isOwnerManualLiveFlow bookings, which
// only the owner's own account can ever satisfy (see _owner-easer.js + migration 042).
async function completeOfflineOwnerManualBooking(sb, res, {
  booking,
  user,
  completionEvidence,
  operationKey,
}) {
  const totalCents = Number(booking.total_price || 0);
  if (!(totalCents > 0)) {
    return res.status(409).json({
      error: 'This job cannot be completed until a positive final price is set.',
      code: 'PRICE_NOT_SET',
    });
  }

  let feeSnapshot;
  try {
    feeSnapshot = await resolveOrCreateEaserFeeSnapshot(sb, booking, user.id);
  } catch (feeError) {
    console.error('Offline owner-manual completion fee snapshot error:', feeError);
    return res.status(503).json({ error: feeError.message, code: feeError.code });
  }

  // Canonical split — tax is a pass-through liability, excluded from the payout
  // base, exactly like the online path. The owner-Easer earns the normal payout.
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: totalCents,
    taxCents: booking.tax_amount || 0,
    feePct: feeSnapshot.feePct,
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  const now = new Date().toISOString();

  // This completion creates canonical earnings and payout state even though it
  // does not touch Stripe. Use the same row-locked financial reservation as the
  // card completion path so owner edits, collection changes, cancellation, and
  // duplicate completion cannot cross this money write.
  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: 'completion_easer',
      expectedStatuses: [BOOKING_STATUS.IN_PROGRESS],
      expectedAssemblerId: user.id,
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

  const completionUpdates = {
    status: BOOKING_STATUS.COMPLETED,
    completed_at: now,
    completed_by: 'assembler',
    amount_charged: totalCents,
    platform_fee_pct: split.feePct,
    platform_fee: split.platformFeeCents,
    assembler_due: split.assemblerDueCents,
    payout_status: split.assemblerDueCents > 0 ? 'pending' : null,
    // Offline customer funds are outside the platform Stripe balance. Even when
    // Connect is enabled for online work, this payout must be recorded manually.
    payout_mode_snapshot: split.assemblerDueCents > 0 ? 'manual' : null,
    payout_review_status: 'not_required',
    // Processing fee for how the customer paid this offline job (0 for cash/bank
    // rails, the card rate for card rails) — one rule, from _offline-payment.js.
    stripe_fee: booking.stripe_fee != null
      ? Number(booking.stripe_fee)
      : offlineMethodFeeCents(booking.payment_method, totalCents),
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
    return_visit_required: false,
    return_visit_completed_at: booking.return_visit_required ? now : booking.return_visit_completed_at,
  };
  let completionUpdate = sb.from('bookings').update(completionUpdates)
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.IN_PROGRESS)
    .eq('assembler_id', user.id)
    .eq('source', 'owner_manual')
    .eq('payment_status', 'offline_recorded')
    .eq('total_price', booking.total_price)
    .eq('payment_collected', booking.payment_collected === true)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'completion_easer');
  completionUpdate = booking.tax_amount == null
    ? completionUpdate.is('tax_amount', null)
    : completionUpdate.eq('tax_amount', booking.tax_amount);
  completionUpdate = booking.payment_method == null
    ? completionUpdate.is('payment_method', null)
    : completionUpdate.eq('payment_method', booking.payment_method);
  const { data: rows, error: updateErr } = await completionUpdate.select('id');

  if (updateErr || !rows?.length) {
    if (updateErr) console.error('Offline owner-manual completion update error:', updateErr);
    const { data: current, error: currentError } = await sb
      .from('bookings')
      .select('status, source, payment_status, payment_collected, payout_status, assembler_id, financial_operation_key')
      .eq('id', booking.id)
      .maybeSingle();
    if (!currentError
        && current?.status === BOOKING_STATUS.COMPLETED
        && current?.source === 'owner_manual'
        && current?.payment_status === 'offline_recorded'
        && current?.assembler_id === user.id) {
      return res.status(200).json({
        success: true, alreadyCompleted: true, offline: true,
        booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
        payout: current.payout_status === 'paid'
          ? { status: 'paid' }
          : { status: current.payment_collected ? 'pending_manual' : 'on_hold_customer_collection' },
      });
    }
    if (!currentError
        && current?.status === BOOKING_STATUS.IN_PROGRESS
        && current?.financial_operation_key === operationKey) {
      try {
        await releaseBookingFinancialOperation(sb, { bookingId: booking.id, operationKey });
      } catch (releaseError) {
        console.error('Offline owner-manual completion lock release failed:', releaseError);
        return res.status(503).json({
          error: 'Completion did not finish and its financial lock needs owner review before retrying.',
          code: 'OFFLINE_COMPLETION_RECONCILIATION_REQUIRED',
        });
      }
    }
    return res.status(currentError ? 503 : 409).json({
      error: currentError
        ? 'Completion state could not be reconciled. Owner review is required before retrying.'
        : 'Job or payment state changed before completion. Refresh and try again.',
      code: currentError ? 'OFFLINE_COMPLETION_RECONCILIATION_REQUIRED' : 'OFFLINE_COMPLETION_STATE_CHANGED',
    });
  }

  // The owner-Easer earns the completion + earnings credit like any Easer.
  try {
    const { error: rpcErr } = await sb.rpc('increment_profile_counters', { user_id: user.id, earned_cents: split.assemblerDueCents });
    if (rpcErr) console.error('Offline completion profile counters RPC failed:', rpcErr.message);
  } catch (e) { console.error('Offline completion profile counters error:', e); }

  adjustActiveJobs(sb, user.id, -1).catch(() => {});

  // Customer completion email — identical branding to a dispatched job so the
  // customer never sees this was owner-performed. Photo + review ask included.
  try {
    if (booking.customer_email) {
      let photoBlock = '';
      try {
        const path = completionEvidence?.storage_path;
        if (path) {
          const { data: signed } = await sb.storage.from('booking-evidence').createSignedUrl(path, 60 * 60 * 24 * 30);
          if (signed?.signedUrl) {
            photoBlock = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td>
              <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">Here's a photo of the finished work:</p>
              <img src="${signed.signedUrl}" alt="Completed ${esc(booking.service)}" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e4e4e7;display:block"/>
            </td></tr></table>`;
          }
        }
      } catch (photoErr) { console.error('Offline completion photo signed-url error:', photoErr.message); }

      await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Your job is complete — ${booking.ref}`,
        html: buildStatusEmail({
          customerName: booking.customer_name,
          ref: booking.ref,
          status: 'COMPLETED',
          statusColor: '#065f46',
          statusBg: '#d1fae5',
          headline: `Your job is complete, ${esc((booking.customer_name || '').split(' ')[0])}.`,
          bodyHtml: `<p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> has been completed. Thank you for choosing AssembleAtEase!</p>
            ${photoBlock}
            ${buildReviewCta()}
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions about the completed work? Reply here, call <a href="tel:+17372906129" style="color:#00BFFF;text-decoration:none">737-290-6129</a>, or email <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a>.</p>`,
        }),
        replyTo: ownerEmail(),
        meta: { bookingId: booking.id, notificationType: 'completion', recipientType: 'customer' },
      });
    }
  } catch (e) { console.error('Offline completion customer email error:', e); }

  // Owner earnings summary (owner = the performing Easer here). Completion and
  // collection remain separate truths; never claim funds were collected unless
  // the audited collection fields say so.
  try {
    const collectionSummary = booking.payment_collected
      ? `Customer payment recorded as collected: $${(totalCents / 100).toFixed(2)}.`
      : `Customer payment is not yet recorded as collected. Confirm the exact $${(totalCents / 100).toFixed(2)} customer payment before recording the payout.`;
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Offline job completed — ${booking.ref}`,
      html: `<p>Your offline job <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}) is marked complete.</p>
<p>Customer: ${esc(booking.customer_name)} | Your earnings: $${(split.assemblerDueCents / 100).toFixed(2)}.</p>
<p>${collectionSummary} The external Easer payout remains manual and must be recorded from the Payouts page after every hold clears.</p>`,
      meta: { bookingId: booking.id, notificationType: 'owner_offline_completion', recipientType: 'owner' },
    });
  } catch (e) { console.error('Offline completion owner email error:', e); }

  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'completed',
    actorType: 'easer',
    actorId: user.id,
    actorName: booking.assembler_name || 'Owner (Easer)',
    description: `Offline owner-performed job marked complete. Customer collection: ${booking.payment_collected ? `$${(totalCents / 100).toFixed(2)} collected` : 'not fully collected'}. Easer due: $${(split.assemblerDueCents / 100).toFixed(2)}.`,
    metadata: { source: 'owner_manual', offline: true, amountCharged: totalCents, platformFee: split.platformFeeCents, assemblerDue: split.assemblerDueCents, platformFeePct: split.feePct },
  }).catch(e => console.warn('Offline completion activity log skipped:', e?.message || e));

  return res.status(200).json({
    success: true,
    offline: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
    payout: split.assemblerDueCents > 0
      ? { status: booking.payment_collected ? 'pending_manual' : 'on_hold_customer_collection' }
      : { status: 'none' },
  });
}
