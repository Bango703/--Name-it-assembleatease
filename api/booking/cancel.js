import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, computeCancellationFee, computeBookingSplit } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { appointmentTimestampMs } from './_appt-date.js';

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
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.CANCELLED);
  if (transitionErr) return res.status(400).json({ error: transitionErr });

  // ── Tiered cancellation fee (% of pre-tax service subtotal, never tax) ────
  const waiveFee = req.body.waiveFee === true;
  const noShow = req.body.noShow === true;   // owner flags a customer no-show → imminent tier
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - Date.now()) / 3600000;
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
  });
  const withinCancellationWindow = policy.tier !== 'free';
  const stripeMutationRequired = ['authorized', 'captured', 'deposit_paid'].includes(String(booking.payment_status || '').toLowerCase());

  if (stripeMutationRequired && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Stripe cancellation handling is unavailable. Booking was not changed.',
      code: 'CANCELLATION_CONFIGURATION_UNAVAILABLE',
    });
  }

  // ── Stripe: charge fee or release hold ────────────────────────────────────
  let refundAmount = 0;
  let feeCaptured = 0;
  let proTripCutCents = 0;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      if (booking.payment_status === 'pending' || !booking.stripe_payment_intent_id) {
        // Card was never authorized — no Stripe action needed
      } else if (booking.payment_status === 'captured') {
        // Payment already captured (job was marked complete then cancelled) — issue full refund
        const idempotencyKey = `owner-cancel-refund-${booking.id}`;
        const refund = await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
          metadata: { bookingRef: booking.ref, reason: 'owner_cancelled_post_capture' },
        }, { idempotencyKey });
        refundAmount = refund.amount;
        await writeFinancialAudit(sb, {
          eventType: 'refund_attempt',
          eventSource: 'booking_cancel_owner',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          refundId: refund.id,
          idempotencyKey,
          status: 'processed',
          metadata: { reason: 'owner_cancelled_post_capture', refundAmount },
        });
      } else if (booking.payment_status === 'authorized') {
        if (!waiveFee && policy.feeCents > 0) {
          // Capture the tiered cancellation fee. Clamp to the actual authorized
          // amount (not total_price, which may have been edited) so a capture can
          // never exceed what Stripe holds.
          const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
          const feeCents = Math.min(policy.feeCents, pi.amount);
          const idempotencyKey = `owner-cancel-fee-${booking.id}-${feeCents}`;
          await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
            amount_to_capture: feeCents,
          }, { idempotencyKey });
          feeCaptured = feeCents;
          await writeFinancialAudit(sb, {
            eventType: 'capture_attempt',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: booking.stripe_payment_intent_id,
            idempotencyKey,
            status: 'processed',
            metadata: { reason: noShow ? 'owner_no_show_fee' : 'owner_cancel_fee', feeCaptured, tier: policy.tier, feePct: policy.feePct },
          });
        } else {
          // Outside window or fee waived — release hold entirely
          const idempotencyKey = `owner-cancel-release-${booking.id}`;
          await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
          await writeFinancialAudit(sb, {
            eventType: 'capture_release',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: booking.stripe_payment_intent_id,
            idempotencyKey,
            status: 'processed',
            metadata: { reason: 'owner_cancel_release' },
          });
        }
      } else if (booking.payment_status === 'deposit_paid') {
        // Deposit already captured — refund it
        const depositIntentId = booking.stripe_deposit_intent_id || booking.stripe_payment_intent_id;
        if (depositIntentId) {
          const idempotencyKey = `owner-cancel-deposit-refund-${booking.id}`;
          const refund = await stripe.refunds.create({
            payment_intent: depositIntentId,
            metadata: { bookingRef: booking.ref, reason: 'owner_cancelled' },
          }, { idempotencyKey });
          refundAmount = refund.amount;
          await writeFinancialAudit(sb, {
            eventType: 'refund_attempt',
            eventSource: 'booking_cancel_owner',
            bookingId: booking.id,
            paymentIntentId: depositIntentId,
            refundId: refund.id,
            idempotencyKey,
            status: 'processed',
            metadata: { reason: 'owner_cancelled', refundAmount },
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
      return res.status(502).json({
        error: 'We could not complete the Stripe portion of this cancellation. Booking was not changed.',
        code: 'CANCELLATION_STRIPE_FAILED',
      });
    }
  }

  // Pro trip cut for no-show / en-route cancellations — recorded for manual payout.
  if (feeCaptured > 0 && policy.proTripCut && booking.assembler_id) {
    try {
      const { data: easerProf } = await sb.from('profiles').select('has_membership').eq('id', booking.assembler_id).single();
      proTripCutCents = computeBookingSplit(feeCaptured, easerProf?.has_membership === true, { taxCents: 0 }).assemblerDueCents;
    } catch (e) { console.error('pro trip-cut calc error:', e); }
  }

  const cancelledAt = new Date().toISOString();
  const updates = {
    status: BOOKING_STATUS.CANCELLED,
    cancelled_at: cancelledAt,
    cancel_reason: reason || null,
    cancellation_fee: feeCaptured || null,
  };

  if (booking.payment_status === 'authorized') {
    if (feeCaptured > 0) {
      updates.payment_status = 'cancellation_fee_captured';
      updates.payment_captured_at = cancelledAt;
      updates.amount_charged = feeCaptured;
      updates.tax_amount = 0;
    } else {
      updates.payment_status = 'released';
      updates.amount_charged = 0;
      updates.tax_amount = 0;
    }
  } else if (refundAmount > 0) {
    updates.payment_status = 'refunded';
    updates.refund_amount = refundAmount;
    updates.refunded_at = cancelledAt;
  }

  const { error: updateErr } = await sb.from('bookings')
    .update(updates)
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Cancel update error:', updateErr);
    return res.status(500).json({ error: 'Failed to cancel booking: ' + updateErr.message });
  }

  // Cancel all open dispatch offers so Easers cannot accept a cancelled booking
  sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', booking.id)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .then(({ error: doErr }) => {
      if (doErr) console.error('dispatch_offers cancel cleanup error:', doErr.message);
    });

  // Release the assigned Easer's daily job slot (if one was assigned)
  if (booking.assembler_id) {
    adjustActiveJobs(sb, booking.assembler_id, -1).catch(() => {});
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
    });
  } catch (emailErr) {
    console.error('Cancel email error:', emailErr);
  }

  logActivity(sb, { bookingId: booking.id, eventType: 'cancelled', actorType: 'owner', actorName: 'Owner', description: `Booking cancelled${reason ? ': ' + reason : ''}${feeCaptured ? ' (fee charged: $' + (feeCaptured/100).toFixed(2) + ', ' + policy.feePct + '% ' + policy.tier + ')' : ''}${proTripCutCents ? ' (pro trip cut owed: $' + (proTripCutCents/100).toFixed(2) + ')' : ''}${refundAmount ? ' (refunded: $' + (refundAmount/100).toFixed(2) + ')' : ''}`, metadata: { reason, feeCaptured, refundAmount, tier: policy.tier, feePct: policy.feePct, proTripCutCents } });

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.CANCELLED }, refundAmount, feeCaptured, withinCancellationWindow, tier: policy.tier, feePct: policy.feePct, proTripCutCents });
}
