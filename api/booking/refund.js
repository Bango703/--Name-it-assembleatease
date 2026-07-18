import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { releaseBookingFinancialOperation, reserveBookingFinancialOperation } from './_financial-operation.js';
import { bookingPaymentIntentIds, loadBookingStripeRefundTruth, refundAllRemainingBookingCharges } from './_stripe-refund-truth.js';
import { reconcileRefundAssembleCash } from './_refund-credits.js';

/**
 * POST /api/booking/refund
 * Owner-only: issue a full or partial Stripe refund and notify the customer.
 * Body: { bookingId?, ref?, reason? }
 * Launch mode deliberately supports only the full remaining refundable amount.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref, amount, reason } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (!bookingPaymentIntentIds(booking).length) {
    return res.status(400).json({ error: 'No Stripe payment found for this booking' });
  }
  if (booking.payment_status === 'authorized') {
    return res.status(400).json({ error: 'This payment has not been captured yet — the card hold has not been charged. Cancel the booking instead to release the hold on the customer\'s card.' });
  }
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Stripe is unavailable. No refund was attempted.' });

  let stripeRefund;
  let refundAmountCents;
  let capturedAmountCents;
  let priorRefundedCents;
  let cumulativeRefundCents;
  let idempotencyKey;
  let operationKey = null;
  let operationReserved = false;
  let stripeRefundMutationStarted = false;
  const easerPayoutReviewRequired = requiresEaserPayoutReview(booking);
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const stripeTruth = await loadBookingStripeRefundTruth({ stripe, booking });
    capturedAmountCents = stripeTruth.capturedCents;
    priorRefundedCents = stripeTruth.refundedCents;
    if (capturedAmountCents <= 0) return res.status(409).json({ error: 'Stripe has no captured charge to refund.' });
    const dbRefundedCents = Number(booking.refund_amount || 0);

    // A webhook may have synchronized Stripe truth after a prior API response
    // failed but before this retry. In that case, clear only the matching
    // completed refund lock and return the reconciled result; never refund the
    // remaining balance in the same recovery request.
    const synchronizedOperationKey = `refund:owner:${booking.id}:total:${priorRefundedCents}`;
    if (priorRefundedCents > 0
        && priorRefundedCents === dbRefundedCents
        && booking.financial_operation_key === synchronizedOperationKey
        && booking.financial_operation_type === 'refund_owner') {
      const rewardsReversal = await reconcileRefundAssembleCash({
        sb,
        booking,
        cumulativeRefundCents: priorRefundedCents,
        eventSource: 'booking_refund_reconciliation',
        fullyRefunded: priorRefundedCents >= capturedAmountCents,
      });
      if (!rewardsReversal.ok) {
        await holdRefundForReconciliation(
          sb,
          booking.id,
          synchronizedOperationKey,
          'AssembleCash could not be reconciled after Stripe completed the refund.',
        );
        return res.status(202).json({
          success: false,
          reconciliationRequired: true,
          code: 'REFUND_REWARDS_RECONCILIATION_REQUIRED',
          message: 'The refund is recorded, but rewards reconciliation is still open. Do not retry the refund or issue a payout.',
        });
      }
      if (['paid', 'transferred'].includes(booking.payout_status)) {
        const clawback = await ensureClawbackAudit({
          sb,
          booking,
          eventSource: 'booking_refund_reconciliation',
          cumulativeRefundCents: priorRefundedCents,
          refundAmountCents: priorRefundedCents,
        });
        if (!clawback.ok) {
          await holdRefundForReconciliation(
            sb,
            booking.id,
            synchronizedOperationKey,
            'The post-payout refund clawback audit could not be persisted.',
          );
          return res.status(202).json({
            success: false,
            reconciliationRequired: true,
            code: 'REFUND_CLAWBACK_RECONCILIATION_REQUIRED',
            message: 'The refund and rewards are recorded, but the Easer payout recovery record is still open. Do not release this hold manually.',
          });
        }
      }
      const released = await finalizeRefundReconciliation(sb, booking.id, synchronizedOperationKey);
      if (!released) {
        return res.status(503).json({
          error: 'Stripe and booking refund totals match, but the refund lock could not be reconciled.',
          code: 'REFUND_RECONCILIATION_REQUIRED',
        });
      }
      return res.status(200).json({
        success: true,
        reconciled: true,
        cumulativeRefundAmount: priorRefundedCents,
        paymentStatus: booking.payment_status,
      });
    }

    // Recover safely from a prior Stripe-success/DB-failure without issuing a
    // second refund. Stripe cumulative refunded amount is financial truth.
    if (priorRefundedCents > dbRefundedCents) {
      const recoveredStatus = priorRefundedCents >= capturedAmountCents ? 'refunded' : 'partially_refunded';
      const existingRefundTarget = ownerRefundOperationTarget(booking);
      operationKey = existingRefundTarget != null && existingRefundTarget >= priorRefundedCents
        ? booking.financial_operation_key
        : `refund:owner:${booking.id}:total:${priorRefundedCents}`;
      await reserveRefundOperation(sb, booking, operationKey);
      operationReserved = true;
      const keepRefundLock = stripeTruth.pendingRefundCents > 0;
      const { error: reconcileErr, data: reconcileRows } = await sb.from('bookings').update({
        payment_status: recoveredStatus,
        refund_amount: priorRefundedCents,
        refunded_at: new Date().toISOString(),
        ...(easerPayoutReviewRequired ? {
          payout_review_status: 'review_required',
          payout_reviewed_at: null,
          payout_reviewed_by: null,
          payout_review_notes: null,
        } : {}),
      }).eq('id', booking.id)
        .eq('financial_operation_key', operationKey)
        .eq('financial_operation_type', 'refund_owner')
        .select('id');
      if (reconcileErr || !reconcileRows?.length) {
        return res.status(500).json({
          error: 'Stripe refund exists, but booking reconciliation still failed. Do not issue another refund; owner reconciliation is required.',
          code: 'REFUND_RECONCILIATION_REQUIRED',
        });
      }
      const rewardsReversal = await reconcileRefundAssembleCash({
        sb,
        booking,
        cumulativeRefundCents: priorRefundedCents,
        eventSource: 'booking_refund_reconciliation',
        fullyRefunded: recoveredStatus === 'refunded',
      });
      let clawbackReconciliationRequired = false;
      if (['paid', 'transferred'].includes(booking.payout_status)) {
        const newlyReconciledCents = priorRefundedCents - dbRefundedCents;
        const clawback = await ensureClawbackAudit({
          sb,
          booking,
          eventSource: 'booking_refund_reconciliation',
          cumulativeRefundCents: priorRefundedCents,
          refundAmountCents: newlyReconciledCents,
        });
        clawbackReconciliationRequired = !clawback.ok;
      }
      if (keepRefundLock) {
        await holdRefundForReconciliation(
          sb,
          booking.id,
          operationKey,
          'Stripe still has a pending refund. The booking must remain financially locked.',
        );
        return res.status(202).json({
          success: false,
          pending: true,
          reconciledRefundAmount: priorRefundedCents,
          pendingRefundAmount: stripeTruth.pendingRefundCents,
          paymentStatus: recoveredStatus,
          rewardsReconciliationRequired: !rewardsReversal.ok,
          clawbackReconciliationRequired,
          message: 'A successful portion was reconciled, but Stripe still has a pending refund. The booking remains financially locked.',
        });
      }
      if (!rewardsReversal.ok || clawbackReconciliationRequired) {
        await holdRefundForReconciliation(
          sb,
          booking.id,
          operationKey,
          !rewardsReversal.ok
            ? 'AssembleCash could not be reconciled after Stripe completed the refund.'
            : 'The post-payout refund clawback audit could not be persisted.',
        );
        return res.status(202).json({
          success: false,
          reconciliationRequired: true,
          reconciledRefundAmount: priorRefundedCents,
          paymentStatus: recoveredStatus,
          rewardsReconciliationRequired: !rewardsReversal.ok,
          clawbackReconciliationRequired,
          message: 'Stripe refund truth is recorded, but financial reconciliation remains open. Do not retry the refund or issue a payout.',
        });
      }
      const released = await finalizeRefundReconciliation(sb, booking.id, operationKey);
      if (!released) {
        return res.status(503).json({
          error: 'Stripe and rewards are reconciled, but the booking refund lock could not be released.',
          code: 'REFUND_RECONCILIATION_REQUIRED',
        });
      }
      operationReserved = false;
      return res.status(200).json({
        success: true,
        reconciled: true,
        cumulativeRefundAmount: priorRefundedCents,
        paymentStatus: recoveredStatus,
        rewardsReconciliationRequired: !rewardsReversal.ok,
        clawbackReconciliationRequired,
      });
    }

    if (stripeTruth.pendingRefundCents > 0) {
      return res.status(202).json({
        success: false,
        pending: true,
        cumulativeRefundAmount: priorRefundedCents,
        pendingRefundAmount: stripeTruth.pendingRefundCents,
        message: 'Stripe still has a pending refund for this booking. Do not retry the refund or pay the Easer until it settles.',
      });
    }

    if (!['completed', 'cancelled', 'canceled'].includes(String(booking.status || '').toLowerCase())) {
      return res.status(409).json({
        error: 'A new refund can only be issued after the booking is completed or cancelled. Cancel or complete the operational workflow first.',
        code: 'BOOKING_NOT_FINAL_FOR_REFUND',
      });
    }

    const remainingRefundable = Math.max(0, capturedAmountCents - priorRefundedCents);
    if (remainingRefundable <= 0) return res.status(409).json({ error: 'This charge has already been fully refunded.' });
    if (amount != null && Number.parseInt(amount, 10) !== remainingRefundable) {
      return res.status(400).json({
        error: 'Partial or browser-supplied refund amounts are disabled in launch mode. This action refunds the full remaining captured amount.',
      });
    }
    refundAmountCents = remainingRefundable;
    cumulativeRefundCents = priorRefundedCents + refundAmountCents;
    idempotencyKey = `booking-refund-${booking.id}-total-${cumulativeRefundCents}`;
    operationKey = `refund:owner:${booking.id}:total:${cumulativeRefundCents}`;
    await reserveRefundOperation(sb, booking, operationKey);
    operationReserved = true;

    const attemptAudit = await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      idempotencyKey,
      status: 'processing',
      metadata: { ref: booking.ref, amount: refundAmountCents },
    });
    if (!attemptAudit?.ok) {
      await releaseBookingFinancialOperation(sb, { bookingId: booking.id, operationKey });
      operationReserved = false;
      return res.status(503).json({
        error: 'The refund audit trail could not be opened, so no Stripe refund was attempted.',
        code: 'REFUND_AUDIT_UNAVAILABLE',
      });
    }

    stripeRefundMutationStarted = true;
    const aggregateRefund = await refundAllRemainingBookingCharges({
      stripe,
      booking,
      reason: reason?.trim() || '',
      keyPrefix: 'booking-refund',
    });
    const refundObjects = aggregateRefund.refunds.map(entry => entry.refund);
    const lastRefund = refundObjects[refundObjects.length - 1] || null;
    const allAttemptedRefundsSucceeded = refundObjects.length > 0
      && refundObjects.every(refund => refund.status === 'succeeded');
    const pendingRefund = refundObjects.find(refund => !['succeeded', 'failed', 'canceled'].includes(String(refund.status || '')));
    const failedRefund = refundObjects.find(refund => ['failed', 'canceled'].includes(String(refund.status || '')));
    stripeRefund = {
      id: lastRefund?.id || null,
      amount: refundAmountCents,
      status: aggregateRefund.after.fullyRefunded && allAttemptedRefundsSucceeded
        ? 'succeeded'
        : (pendingRefund?.status || failedRefund?.status || 'pending'),
    };

    const resultAudit = await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      refundId: stripeRefund.id,
      idempotencyKey,
      status: aggregateRefund.after.fullyRefunded && allAttemptedRefundsSucceeded
        ? 'processed'
        : String(stripeRefund.status || 'pending'),
      metadata: {
        ref: booking.ref,
        amount: refundAmountCents,
        stripeStatus: stripeRefund.status,
        refundIds: refundObjects.map(refund => refund.id),
        capturedTotal: aggregateRefund.after.capturedCents,
        refundedTotal: aggregateRefund.after.refundedCents,
      },
      error: aggregateRefund.error?.message || null,
    });
    if (!resultAudit?.ok) {
      return res.status(503).json({
        error: 'Stripe refund activity could not be durably audited. The booking remains locked; verify Stripe before retrying or paying the Easer.',
        code: 'REFUND_RECONCILIATION_REQUIRED',
        refundId: stripeRefund.id,
      });
    }

    if (!aggregateRefund.after.fullyRefunded || !allAttemptedRefundsSucceeded) {
      const stripeRefundAdvanced = aggregateRefund.after.refundedCents > priorRefundedCents;
      if ((aggregateRefund.error || failedRefund) && !stripeRefundAdvanced && !pendingRefund) {
        const released = await releaseBookingFinancialOperation(sb, { bookingId: booking.id, operationKey });
        operationReserved = false;
        if (!released) {
          return res.status(503).json({
            error: 'Stripe did not complete the refund, but the booking safety lock needs reconciliation before retrying.',
            code: 'REFUND_RECONCILIATION_REQUIRED',
            refundId: stripeRefund.id,
          });
        }
        return res.status(409).json({
          error: `Stripe did not complete the refund (${stripeRefund.status}). No booking refund was recorded.`,
          code: 'REFUND_NOT_SUCCEEDED',
          refundId: stripeRefund.id,
        });
      }

      // Keep the operation lock while Stripe is pending. A later webhook or
      // owner retry reconciles this exact idempotent refund before any payout
      // or second refund can begin.
      return res.status(202).json({
        success: false,
        pending: true,
        reconciliationRequired: !!aggregateRefund.error || !!failedRefund,
        refundId: stripeRefund.id,
        status: stripeRefund.status || 'pending',
        message: stripeRefundAdvanced
          ? 'Stripe completed part of this aggregate refund and the rest needs reconciliation. Do not issue another refund or payout; check this booking again.'
          : 'Stripe is still processing the refund. Do not issue another refund or payout; check again from this booking.',
      });
    }
    cumulativeRefundCents = aggregateRefund.after.refundedCents;
  } catch (stripeErr) {
    if (stripeErr?.code === 'FINANCIAL_OPERATION_CONFLICT') {
      return res.status(409).json({ error: stripeErr.message, code: stripeErr.code });
    }
    if (stripeErr?.code === 'FINANCIAL_OPERATION_RESERVATION_FAILED') {
      return res.status(503).json({ error: stripeErr.message, code: stripeErr.code });
    }
    console.error('Stripe refund error:', stripeErr);
    await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      idempotencyKey,
      status: 'failed',
      metadata: { ref: booking.ref, amount: refundAmountCents },
      error: stripeErr?.raw?.message || stripeErr.message || 'Refund failed',
    });
    if (operationReserved && operationKey && !stripeRefundMutationStarted) {
      try {
        await releaseBookingFinancialOperation(sb, { bookingId: booking.id, operationKey });
      } catch (releaseError) {
        console.error('Refund reservation release error:', releaseError);
        return res.status(503).json({
          error: 'Stripe did not complete the refund, but the booking lock could not be released. Verify Stripe before retrying.',
          code: 'REFUND_RECONCILIATION_REQUIRED',
        });
      }
    }
    return res.status(stripeRefundMutationStarted ? 503 : 500).json({
      error: stripeRefundMutationStarted
        ? 'Stripe refund outcome could not be fully verified. The booking remains locked; do not retry or pay out until reconciliation completes.'
        : (stripeErr?.raw?.message || stripeErr.message || 'Refund failed'),
      code: stripeRefundMutationStarted ? 'REFUND_RECONCILIATION_REQUIRED' : undefined,
    });
  }

  const paymentStatus = cumulativeRefundCents >= capturedAmountCents ? 'refunded' : 'partially_refunded';
  // Update cumulative booking refund truth. Each Stripe refund remains durable
  // in financial_event_audit; refund_id is the most recent Stripe refund.
  const { error: updateErr, data: updatedRows } = await sb.from('bookings').update({
    payment_status: paymentStatus,
    refund_id: stripeRefund.id,
    refund_amount: cumulativeRefundCents,
    refunded_at: new Date().toISOString(),
    refund_reason: reason?.trim() || null,
    ...(easerPayoutReviewRequired ? {
      payout_review_status: 'review_required',
      payout_reviewed_at: null,
      payout_reviewed_by: null,
      payout_review_notes: null,
    } : {}),
  }).eq('id', booking.id)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'refund_owner')
    .select('id');

  // Keep the refund reservation until the database-serialized rewards reversal
  // succeeds. This prevents refunded credit from being spent by a concurrent
  // checkout.
  let rewardsReversal = { ok: false, error: 'Refund state was not persisted' };
  if (!updateErr && updatedRows && updatedRows.length > 0) {
    rewardsReversal = await reconcileRefundAssembleCash({
      sb,
      booking,
      cumulativeRefundCents,
      eventSource: 'booking_refund_owner',
      fullyRefunded: paymentStatus === 'refunded',
    });
  }

  if (updateErr || !updatedRows?.length) {
    console.error('Refund DB update error:', updateErr);
    await writeFinancialAudit(sb, {
      eventType: 'refund_sync',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      refundId: stripeRefund.id,
      status: 'failed',
      metadata: { ref: booking.ref, amount: stripeRefund.amount },
      error: updateErr?.message || 'Failed to persist refund state to booking',
    });
    return res.status(500).json({
      error: 'Stripe processed the refund, but booking reconciliation failed. Retry this action to reconcile; do not issue another refund in Stripe.',
      code: 'REFUND_RECONCILIATION_REQUIRED',
      refundId: stripeRefund.id,
    });
  }
  if (!updateErr) {
    logActivity(sb, {
      bookingId: booking.id,
      eventType: 'refunded',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Refund processed: $${(stripeRefund.amount / 100).toFixed(2)}${reason ? ` — ${reason}` : ''}`,
      metadata: {
        refundId: stripeRefund.id,
        refundAmount: stripeRefund.amount,
        refundStatus: stripeRefund.status,
        reason: reason?.trim() || null,
      },
    });
  }

  const payoutReviewRequired = ['paid', 'transferred'].includes(booking.payout_status);
  let clawbackAuditReconciliationRequired = false;
  if (payoutReviewRequired) {
    // Durable clawback record — money owed back by the Easer after a post-payout
    // refund. Persisted (not just emailed) so it surfaces in the owner dashboard
    // until recovered. Recovery/set-off stays manual until Stripe Connect.
    const clawbackOwedCents = Math.min(stripeRefund.amount, booking.payout_amount || booking.assembler_due || 0);
    const clawbackKey = `clawback:${booking.id}:refund-total:${cumulativeRefundCents}`;
    const { data: existingClawback, error: clawbackLookupError } = await sb.from('financial_event_audit')
      .select('id')
      .eq('idempotency_key', clawbackKey)
      .limit(1)
      .maybeSingle();
    let clawbackAudit = existingClawback ? { ok: true } : (!clawbackLookupError ? await writeFinancialAudit(sb, {
      eventType: 'clawback_required',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      refundId: stripeRefund.id,
      idempotencyKey: clawbackKey,
      status: 'open',
      metadata: {
        ref: booking.ref,
        assemblerId: booking.assembler_id || null,
        assemblerName: booking.assembler_name || null,
        refundAmountCents: stripeRefund.amount,
        assemblerDueCents: booking.assembler_due || 0,
        payoutAmountCents: booking.payout_amount || 0,
        clawbackOwedCents,
      },
    }) : { ok: false, error: clawbackLookupError.message });
    if (!clawbackAudit?.ok) {
      // A simultaneous webhook can win the unique clawback insert. Re-read
      // before surfacing a warning so the owner does not see a false failure.
      const { data: racedClawback } = await sb.from('financial_event_audit')
        .select('id')
        .eq('idempotency_key', clawbackKey)
        .limit(1)
        .maybeSingle();
      clawbackAudit = racedClawback ? { ok: true } : clawbackAudit;
    }
    clawbackAuditReconciliationRequired = !clawbackAudit?.ok;
    if (clawbackAuditReconciliationRequired) {
      console.error('Refund clawback owner action could not be persisted:', clawbackAudit?.error || 'unknown audit failure');
    }
    try {
      const refundDisplay = `$${(stripeRefund.amount / 100).toFixed(2)}`;
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Payout Review Required — Refund after payout — ${esc(booking.ref)}`,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#18181b">
            <h2 style="margin:0 0 12px">Refund issued after Easer payout was marked paid</h2>
            <p style="margin:0 0 16px;line-height:1.6">Booking <strong>${esc(booking.ref)}</strong> has been refunded for <strong>${refundDisplay}</strong>, but payout status is already <strong>paid</strong>.</p>
            <p style="margin:0;line-height:1.6">Review whether this needs an Easer recovery, owner adjustment, or manual ledger note before closing the job financially.</p>
          </div>`,
      });
    } catch (notifyErr) {
      console.error('Refund payout review email error:', notifyErr);
    }
  }

  let financialReconciliationRequired = !rewardsReversal.ok || clawbackAuditReconciliationRequired;
  if (financialReconciliationRequired) {
    await holdRefundForReconciliation(
      sb,
      booking.id,
      operationKey,
      !rewardsReversal.ok
        ? 'AssembleCash could not be reconciled after Stripe completed the refund.'
        : 'The post-payout refund clawback audit could not be persisted.',
    );
  } else {
    const released = await finalizeRefundReconciliation(sb, booking.id, operationKey);
    if (!released) {
      financialReconciliationRequired = true;
      await holdRefundForReconciliation(
        sb,
        booking.id,
        operationKey,
        'Stripe and rewards are reconciled, but the refund operation lock could not be released.',
      );
    } else {
      operationReserved = false;
    }
  }

  // #7 — Send customer refund email
  try {
    const refundDisplay = `$${(stripeRefund.amount / 100).toFixed(2)}`;
    const totalDisplay = booking.amount_charged ? `$${(booking.amount_charged / 100).toFixed(2)}` : null;
    const isPartial = paymentStatus === 'partially_refunded';

    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'REFUNDED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your refund is on the way, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">We've processed a ${isPartial ? 'partial ' : ''}refund for your <strong>${esc(booking.service)}</strong> booking.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
          <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Refund Amount</p>
          <p style="margin:0;font-size:26px;font-weight:700;color:#065f46">${refundDisplay}</p>
          ${totalDisplay && isPartial ? `<p style="margin:4px 0 0;font-size:12px;color:#166534">of ${totalDisplay} total charged</p>` : ''}
        </td></tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px">
          <table width="100%">
            <tr><td style="padding:5px 0;color:#71717a;width:120px">Reference</td><td style="padding:5px 0;font-weight:600">${esc(booking.ref)}</td></tr>
            <tr><td style="padding:5px 0;color:#71717a">Service</td><td style="padding:5px 0">${esc(booking.service)}</td></tr>
            ${reason ? `<tr><td style="padding:5px 0;color:#71717a;vertical-align:top">Reason</td><td style="padding:5px 0">${esc(reason)}</td></tr>` : ''}
          </table>
        </td></tr></table>
        <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Refunds typically appear within 5–10 business days depending on your bank. Questions? Contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your refund is on the way — ${booking.ref}`,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Refund email error:', emailErr);
  }

  return res.status(financialReconciliationRequired ? 202 : 200).json({
    success: !financialReconciliationRequired,
    refundId: stripeRefund.id,
    amount: stripeRefund.amount,
    cumulativeRefundAmount: cumulativeRefundCents,
    paymentStatus,
    status: stripeRefund.status,
    payoutReviewRequired: payoutReviewRequired || easerPayoutReviewRequired,
    rewardsReconciliationRequired: !rewardsReversal.ok,
    clawbackAuditReconciliationRequired,
    financialReconciliationRequired,
    message: financialReconciliationRequired
      ? 'The customer refund is recorded, but financial reconciliation remains open. Do not retry the refund or issue a payout.'
      : undefined,
  });
}

async function holdRefundForReconciliation(sb, bookingId, operationKey, reason) {
  const { error, data } = await sb.from('bookings').update({
    financial_reconciliation_required_at: new Date().toISOString(),
    financial_reconciliation_reason: String(reason || 'Refund reconciliation is required').slice(0, 1000),
  })
    .eq('id', bookingId)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'refund_owner')
    .select('id');
  if (error || !data?.length) {
    console.error('Refund reconciliation hold could not be persisted:', error?.message || 'reservation changed');
    return false;
  }
  return true;
}

async function finalizeRefundReconciliation(sb, bookingId, operationKey) {
  const { error, data } = await sb.from('bookings').update({
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
    financial_reconciliation_required_at: null,
    financial_reconciliation_reason: null,
  })
    .eq('id', bookingId)
    .eq('financial_operation_key', operationKey)
    .eq('financial_operation_type', 'refund_owner')
    .select('id');
  if (error || !data?.length) {
    console.error('Refund reconciliation release could not be persisted:', error?.message || 'reservation changed');
    return false;
  }
  return true;
}

function ownerRefundOperationTarget(booking) {
  if (booking?.financial_operation_type !== 'refund_owner') return null;
  const prefix = `refund:owner:${booking.id}:total:`;
  if (!String(booking.financial_operation_key || '').startsWith(prefix)) return null;
  const target = Number.parseInt(String(booking.financial_operation_key).slice(prefix.length), 10);
  return Number.isInteger(target) && target > 0 ? target : null;
}

function requiresEaserPayoutReview(booking) {
  return booking?.status === 'completed'
    && !!booking.assembler_id
    && Number(booking.assembler_due || 0) > 0;
}

async function reserveRefundOperation(sb, booking, operationKey) {
  if (booking.financial_operation_key) {
    if (booking.financial_operation_key === operationKey
        && booking.financial_operation_type === 'refund_owner') return;
    const conflict = new Error('Another booking or payment action is already in progress. Refresh before trying again.');
    conflict.code = 'FINANCIAL_OPERATION_CONFLICT';
    throw conflict;
  }

  await reserveBookingFinancialOperation(sb, {
    bookingId: booking.id,
    operationKey,
    operationType: 'refund_owner',
    expectedStatuses: [booking.status],
    expectedAssemblerId: booking.assembler_id || null,
    expectedBooking: booking,
  });
}

async function ensureClawbackAudit({ sb, booking, eventSource, cumulativeRefundCents, refundAmountCents }) {
  const idempotencyKey = `clawback:${booking.id}:refund-total:${cumulativeRefundCents}`;
  const { data: existing, error: lookupError } = await sb.from('financial_event_audit')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, existing: true };
  if (lookupError) return { ok: false, error: lookupError.message || String(lookupError) };

  const audit = await writeFinancialAudit(sb, {
    eventType: 'clawback_required',
    eventSource,
    bookingId: booking.id,
    paymentIntentId: booking.stripe_payment_intent_id,
    idempotencyKey: idempotencyKey,
    status: 'open',
    metadata: {
      ref: booking.ref,
      assemblerId: booking.assembler_id || null,
      assemblerName: booking.assembler_name || null,
      refundAmountCents,
      cumulativeRefundAmountCents: cumulativeRefundCents,
      payoutAmountCents: booking.payout_amount || 0,
      clawbackOwedCents: Math.min(
        cumulativeRefundCents,
        Number(booking.payout_amount || booking.assembler_due || 0),
      ),
    },
  });
  if (audit?.ok) return audit;

  const { data: raced } = await sb.from('financial_event_audit')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .limit(1)
    .maybeSingle();
  return raced ? { ok: true, existing: true } : audit;
}
