import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES, computeBookingSplitFromSnapshot } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { evaluateEaserAppointmentGate } from './_appointment-gates.js';
import { loadCurrentCompletionEvidence } from './_completion-evidence.js';
import { reserveBookingFinancialOperation } from './_financial-operation.js';
import { finalizeCompletionRewards, surfaceCompletionRewardHold } from './_completion-rewards.js';
import { resolveOrCreateEaserFeeSnapshot } from './_easer-fee-snapshot.js';
import { captureOrRecoverBookingPayment } from './_stripe-booking-payment.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  const operationKey = `complete:${booking.id}`;
  if (booking.status === BOOKING_STATUS.COMPLETED) {
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
          actorType: 'owner', actorName: 'Owner', eventSource: 'booking_complete_owner_retry',
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
    return res.status(400).json({ error: 'Booking already completed. Payment already captured.' });
  }
  const capturedRecovery = booking.payment_status === 'captured';
  const positivePrice = Number(booking.total_price || 0) > 0;
  if (!positivePrice) {
    return res.status(409).json({ error: 'Set a positive final price before completing this booking.', code: 'PRICE_NOT_SET' });
  }
  if (positivePrice && !['authorized', 'deposit_paid', 'captured'].includes(booking.payment_status)) {
    return res.status(409).json({
      error: 'Customer payment is not authorized. The booking was not completed and no Easer earnings were created.',
      code: 'PAYMENT_NOT_AUTHORIZED',
    });
  }
  if (['authorized', 'captured', 'deposit_paid'].includes(booking.payment_status)
      && !booking.stripe_payment_intent_id
      && !booking.stripe_deposit_intent_id) {
    return res.status(409).json({ error: 'Payment state has no Stripe PaymentIntent. Resolve payment before completion.' });
  }
  // Allow completion from any active pipeline state — Easer may have progressed through
  // en_route → arrived → in_progress before the owner marks it done.
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    return res.status(400).json({ error: 'Only active bookings can be completed. Current status: ' + booking.status });
  }
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.COMPLETED);
  if (transitionErr) {
    return res.status(400).json({ error: transitionErr });
  }
  if (!booking.assembler_id || !booking.assembler_accepted_at) {
    return res.status(409).json({
      error: 'The assigned Easer must explicitly accept this job before completion.',
      code: 'EASER_ACCEPTANCE_REQUIRED',
    });
  }
  const appointmentGate = evaluateEaserAppointmentGate({
    date: booking.date,
    time: booking.time,
    stage: 'completed',
  });
  if (!appointmentGate.allowed) return res.status(409).json(appointmentGate);

  const completionEvidenceResult = await loadCurrentCompletionEvidence(sb, booking);
  if (completionEvidenceResult.error) {
    console.error('Owner completion evidence lookup failed:', completionEvidenceResult.error);
    return res.status(503).json({ error: 'Completion evidence could not be verified. No payment was captured.' });
  }
  const completionEvidence = completionEvidenceResult.evidence;
  if (!completionEvidence) {
    return res.status(409).json({
      error: 'A completion photo from the current assigned Easer, uploaded after work started, is required before completion.',
      code: 'COMPLETION_EVIDENCE_REQUIRED',
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
    feeSnapshot = await resolveOrCreateEaserFeeSnapshot(sb, booking, booking.assembler_id);
  } catch (feeError) {
    console.error('Owner completion fee snapshot error:', feeError);
    return res.status(503).json({ error: feeError.message, code: feeError.code });
  }

  // Owner and Easer completion share one deterministic key. If Stripe succeeds
  // but one caller loses its response, either trusted completion path can safely
  // reconcile the same charge without creating a second financial operation.
  try {
    await reserveBookingFinancialOperation(sb, {
      bookingId: booking.id,
      operationKey,
      operationType: 'completion_owner',
      expectedStatuses: [BOOKING_STATUS.IN_PROGRESS],
      expectedAssemblerId: booking.assembler_id,
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
        eventSource: 'booking_complete_owner',
      });
      amountCharged = paymentResult.amountCharged;
      actualStripeFee = paymentResult.actualStripeFee;
      balancePaymentIntentId = paymentResult.balancePaymentIntentId;
      balanceAmountCaptured = paymentResult.balanceAmountCaptured;
    } catch (stripeErr) {
      console.error('Stripe capture error:', stripeErr);
      await writeFinancialAudit(sb, {
        eventType: 'capture_attempt',
        eventSource: 'booking_complete_owner',
        bookingId: booking.id,
        paymentIntentId: booking.stripe_payment_intent_id,
        status: 'failed',
        metadata: { ref: booking.ref, paymentStatus: booking.payment_status },
        error: stripeErr?.message || 'Unknown Stripe capture error',
      });

      logActivity(sb, {
        bookingId: booking.id,
        eventType: 'capture_failed',
        actorType: 'owner',
        actorName: 'Owner',
        description: `Payment capture failed during completion: ${stripeErr?.message || 'Unknown Stripe error'}`,
        metadata: { paymentStatus: booking.payment_status, paymentIntentId: booking.stripe_payment_intent_id || null },
      });

      // Notify owner of capture failure so they can resolve manually
      try {
        await sendEmail({
          to: ownerEmail(),
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Payment Capture Failed - ${booking.ref}`,
          html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #fecaca"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#991b1b">Payment Capture Failed</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">The automatic payment capture for booking <strong>${esc(booking.ref)}</strong> failed. The booking was not marked complete and no Easer earnings were created. Manual resolution is required before retrying completion.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
      <table width="100%">
        <tr><td style="padding:5px 0;color:#71717a;width:120px">Reference</td><td style="padding:5px 0;font-weight:600">${esc(booking.ref)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Customer</td><td style="padding:5px 0">${esc(booking.customer_name)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Service</td><td style="padding:5px 0">${esc(booking.service)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Amount Due</td><td style="padding:5px 0;font-weight:700;color:#991b1b">$${((booking.total_price || 0) / 100).toFixed(2)}</td></tr>
        <tr><td style="padding:5px 0;color:#71717a">Error</td><td style="padding:5px 0;color:#991b1b">${esc(stripeErr?.message || 'Unknown Stripe error')}</td></tr>
      </table>
    </td></tr></table>
    <p style="font-size:13px;color:#71717a;line-height:1.6">Log in to the Stripe dashboard to manually capture or re-attempt payment. If the card was declined, contact the customer directly at <a href="mailto:${esc(booking.customer_email)}" style="color:#00BFFF">${esc(booking.customer_email)}</a>.</p>
  </td></tr></table>
</div></body></html>`,
        });
      } catch (alertErr) { console.error('Capture failure alert error:', alertErr); }

      return res.status(502).json({
        error: 'Payment capture failed. Booking was not completed. Please resolve payment and retry.',
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

  const finalAmountCharged = captureRequired ? amountCharged : (amountCharged || booking.total_price || 0);

  if (!captureRequired && finalAmountCharged <= 0) {
    return res.status(400).json({
      error: 'Cannot complete this booking — the total price is $0 or not set. Update the booking price using the Edit button, then try again.',
      code: 'PRICE_NOT_SET',
    });
  }

  // Canonical money split — tax is a pass-through liability and is EXCLUDED from
  // the fee/payout base. AssembleCash is funded by platform margin, so it must
  // never reduce the Easer's payout basis.
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: finalAmountCharged,
    taxCents: booking.tax_amount || 0,
    feePct: feeSnapshot.feePct,
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  const PLATFORM_FEE_PCT = split.feePct;
  const platformFee      = split.platformFeeCents;
  const assemblerDue     = split.assemblerDueCents;
  const payoutStatus     = booking.assembler_id && assemblerDue > 0 ? 'pending' : null;
  let connectPayout = { status: 'disabled' };

  // Atomic guard: only update if not already completed or captured.
  // If another request beat us here (double-click, retry, race with assembler-complete),
  // 0 rows will be updated and we return 400 instead of overwriting.
  const completionPayload = {
      status: BOOKING_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      payment_status: 'captured',
      payment_captured_at: new Date().toISOString(),
      amount_charged: finalAmountCharged,
      platform_fee_pct: PLATFORM_FEE_PCT,
      platform_fee: platformFee,
      assembler_due: assemblerDue,
      payout_status: payoutStatus,
      payout_mode_snapshot: payoutStatus
        ? (isStripeConnectEnabled() ? 'stripe_connect' : 'manual')
        : null,
      payout_review_status: 'not_required',
      stripe_balance_payment_intent_id: balancePaymentIntentId,
      stripe_balance_amount_captured: balanceAmountCaptured,
      financial_reconciliation_required_at: null,
      financial_reconciliation_reason: null,
    };
  if (actualStripeFee != null) completionPayload.stripe_fee = actualStripeFee;
  const completionUpdate = sb
    .from('bookings')
    .update(completionPayload)
    .eq('id', booking.id)
    .eq('status', BOOKING_STATUS.IN_PROGRESS)
    .eq('assembler_id', booking.assembler_id)
    .eq('financial_operation_key', operationKey);
  const { error: updateErr, data: updatedRows } = await completionUpdate.select('id');

  if (updateErr) {
    console.error('Complete update error:', updateErr);
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
            actorType: 'owner', actorName: 'Owner', eventSource: 'booking_complete_owner_race_recovery',
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
      error: 'Completion capture succeeded, but booking state was changed by another request. Review this booking before retrying.',
      code: 'COMPLETION_STATE_RACE',
    });
  }

  // Keep owner-complete aligned with assembler-complete: payouts are held first,
  // then released by cron/manual payout after the review window. This preserves a
  // single payout source of truth and avoids immediate-transfer drift.
  if (booking.assembler_id && assemblerDue > 0) {
    connectPayout = isStripeConnectEnabled()
      ? { status: 'scheduled', note: 'Releases about 48 hours after completion once payout setup is ready.' }
      : { status: 'pending_manual', reason: 'connect-disabled' };
  }

  // Keep the exact completion reservation until the ledger reward and booking
  // reward summary are both verified. A refund cannot start while this key is
  // held. Any ambiguity leaves an owner-visible reconciliation marker.
  const rewardResult = await finalizeCompletionRewards(sb, {
    booking: {
      ...booking,
      status: BOOKING_STATUS.COMPLETED,
      payment_status: 'captured',
      amount_charged: finalAmountCharged,
    },
    operationKey,
    amountChargedCents: finalAmountCharged,
  });
  if (!rewardResult.ok) {
    await surfaceCompletionRewardHold(sb, booking, operationKey, rewardResult, {
      actorType: 'owner', actorName: 'Owner', eventSource: 'booking_complete_owner',
    });
  }

  // Keep the profile display cache aligned with canonical booking earnings.
  if (booking.assembler_id) {
    try {
      const { error: rpcErr } = await sb.rpc('increment_profile_counters', {
        user_id: booking.assembler_id,
        earned_cents: assemblerDue,
      });
      if (rpcErr) console.error('profile counters RPC failed — counter needs reconciliation:', rpcErr.message);
    } catch (countErr) {
      console.error('profile counters increment error:', countErr);
    }
    // Job is done — release the Easer's daily slot
    adjustActiveJobs(sb, booking.assembler_id, -1).catch(() => {});
  }
  try {
    const amountDisplay = finalAmountCharged > 0 ? `$${(finalAmountCharged / 100).toFixed(2)}` : null;
    let photoBlock = '';
    try {
      const { data: signed } = await sb.storage
        .from('booking-evidence')
        .createSignedUrl(completionEvidence.storage_path, 60 * 60 * 24 * 30);
      if (signed?.signedUrl) {
        photoBlock = `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td>
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#374151">Here's a photo of the finished work:</p>
          <img src="${signed.signedUrl}" alt="Completed ${esc(booking.service)}" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e4e4e7;display:block"/>
        </td></tr></table>`;
      }
    } catch (photoError) {
      console.error('Owner completion photo signed-url error:', photoError?.message || photoError);
    }
    const receiptBlock = amountDisplay ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payment Receipt</p>
        <p style="margin:0 0 12px;font-size:28px;font-weight:700;color:#065f46">${amountDisplay}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#166534">
          <tr><td style="padding:3px 0;width:130px">Service</td><td style="padding:3px 0;font-weight:600">${esc(booking.service)}</td></tr>
          <tr><td style="padding:3px 0">Reference</td><td style="padding:3px 0;font-weight:600">${esc(booking.ref)}</td></tr>
          <tr><td style="padding:3px 0">Payment method</td><td style="padding:3px 0">Card on file</td></tr>
          <tr><td style="padding:3px 0">Status</td><td style="padding:3px 0;font-weight:700">Charged</td></tr>
        </table>
        <p style="margin:10px 0 0;font-size:12px;color:#166534;line-height:1.5">A Stripe receipt has been sent separately to <strong>${esc(booking.customer_email)}</strong>.</p>
      </td></tr></table>` : '';

    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'COMPLETED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your job is complete!`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> service has been completed. Thank you for choosing AssembleAtEase!</p>
        ${photoBlock}
        ${receiptBlock}
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">Need help with anything else? We're always here — <a href="https://www.assembleatease.com/book" style="color:#00BFFF;font-weight:600">book your next service</a> anytime.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Payment Receipt & Job Complete — ${booking.ref}`,
      html,
      replyTo: ownerEmail(),
      meta: { bookingId: booking.id, notificationType: 'completion', recipientType: 'customer' },
    });
  } catch (emailErr) {
    console.error('Complete email error:', emailErr);
  }

  // Audit log
  console.log(JSON.stringify({ audit: true, action: 'booking_complete', actor: 'owner', bookingId: booking.id, ref: booking.ref, amountCharged: finalAmountCharged, timestamp: new Date().toISOString() }));

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedwon').catch(e => console.error('HubSpot complete stage error:', e));
  }

  logActivity(sb, { bookingId: booking.id, eventType: 'completed', actorType: 'owner', actorName: 'Owner', description: `Job marked complete by owner. Amount charged: $${((finalAmountCharged||0)/100).toFixed(2)}`, metadata: { amountCharged: finalAmountCharged, platformFee, assemblerDue } });
  return res.status(rewardResult.ok ? 200 : 202).json({
    success: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
    payout: connectPayout,
    reconciliationRequired: !rewardResult.ok,
    code: rewardResult.ok ? undefined : rewardResult.code,
  });
}
