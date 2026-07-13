import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { reverseForBooking as reverseAssembleCashForBooking } from '../_assemblecash.js';

/**
 * POST /api/booking/refund
 * Owner-only: issue a full or partial Stripe refund and notify the customer.
 * Body: { bookingId?, ref?, amount? (cents), reason? }
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
  if (!booking.stripe_payment_intent_id) {
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
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const pi = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id, { expand: ['latest_charge'] });
    if (!['succeeded', 'requires_capture'].includes(pi.status) || pi.metadata?.bookingId !== booking.id) {
      return res.status(409).json({ error: 'Stripe payment state does not match this booking. No refund was attempted.' });
    }
    const charge = typeof pi.latest_charge === 'string'
      ? await stripe.charges.retrieve(pi.latest_charge)
      : pi.latest_charge;
    if (!charge) return res.status(409).json({ error: 'Stripe has no captured charge to refund.' });

    capturedAmountCents = Number(charge.amount || pi.amount_received || booking.amount_charged || 0);
    priorRefundedCents = Number(charge.amount_refunded || 0);
    const dbRefundedCents = Number(booking.refund_amount || 0);

    // Recover safely from a prior Stripe-success/DB-failure without issuing a
    // second refund. Stripe cumulative refunded amount is financial truth.
    if (priorRefundedCents > dbRefundedCents) {
      const recoveredStatus = priorRefundedCents >= capturedAmountCents ? 'refunded' : 'partially_refunded';
      const { error: reconcileErr } = await sb.from('bookings').update({
        payment_status: recoveredStatus,
        refund_amount: priorRefundedCents,
        refunded_at: new Date().toISOString(),
      }).eq('id', booking.id);
      if (reconcileErr) return res.status(500).json({ error: 'Stripe refund exists, but booking reconciliation still failed. Owner action is required.' });
      await reverseAssembleCashForBooking(sb, booking.id, 'reverse:refund_reconciliation');
      if (booking.payout_status === 'paid') {
        const newlyReconciledCents = priorRefundedCents - dbRefundedCents;
        await writeFinancialAudit(sb, {
          eventType: 'clawback_required',
          eventSource: 'booking_refund_reconciliation',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          status: 'open',
          metadata: {
            ref: booking.ref,
            refundAmountCents: newlyReconciledCents,
            cumulativeRefundAmountCents: priorRefundedCents,
            payoutAmountCents: booking.payout_amount || 0,
            clawbackOwedCents: Math.min(newlyReconciledCents, booking.payout_amount || booking.assembler_due || 0),
          },
        });
      }
      return res.status(200).json({
        success: true,
        reconciled: true,
        cumulativeRefundAmount: priorRefundedCents,
        paymentStatus: recoveredStatus,
      });
    }

    const remainingRefundable = Math.max(0, capturedAmountCents - priorRefundedCents);
    if (remainingRefundable <= 0) return res.status(409).json({ error: 'This charge has already been fully refunded.' });
    refundAmountCents = amount != null ? Number.parseInt(amount, 10) : remainingRefundable;
    if (!Number.isInteger(refundAmountCents) || refundAmountCents <= 0 || refundAmountCents > remainingRefundable) {
      return res.status(400).json({ error: `Refund must be between $0.01 and $${(remainingRefundable / 100).toFixed(2)}.` });
    }
    cumulativeRefundCents = priorRefundedCents + refundAmountCents;
    idempotencyKey = `booking-refund-${booking.id}-total-${cumulativeRefundCents}`;

    await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      idempotencyKey,
      status: 'processing',
      metadata: { ref: booking.ref, amount: refundAmountCents },
    });

    stripeRefund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: refundAmountCents,
      reason: 'requested_by_customer',
      metadata: { bookingRef: booking.ref || '', bookingId: booking.id || '', ownerReason: reason?.trim() || '' },
    }, { idempotencyKey });

    await writeFinancialAudit(sb, {
      eventType: 'refund_attempt',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      refundId: stripeRefund.id,
      idempotencyKey,
      status: 'processed',
      metadata: { ref: booking.ref, amount: stripeRefund.amount, stripeStatus: stripeRefund.status },
    });
  } catch (stripeErr) {
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
    return res.status(500).json({ error: stripeErr?.raw?.message || stripeErr.message || 'Refund failed' });
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
  }).eq('id', booking.id).select('id');

  // Reverse any still-available AssembleCash earned from this booking. Idempotent
  // (only touches 'available' earn rows); credit already spent is never clawed back.
  if (!updateErr && updatedRows && updatedRows.length > 0) {
    reverseAssembleCashForBooking(sb, booking.id, 'reverse:refund').catch(() => {});
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

  const payoutReviewRequired = booking.payout_status === 'paid';
  if (payoutReviewRequired) {
    // Durable clawback record — money owed back by the Easer after a post-payout
    // refund. Persisted (not just emailed) so it surfaces in the owner dashboard
    // until recovered. Recovery/set-off stays manual until Stripe Connect.
    const clawbackOwedCents = Math.min(stripeRefund.amount, booking.payout_amount || booking.assembler_due || 0);
    await writeFinancialAudit(sb, {
      eventType: 'clawback_required',
      eventSource: 'booking_refund_owner',
      bookingId: booking.id,
      paymentIntentId: booking.stripe_payment_intent_id,
      refundId: stripeRefund.id,
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
    });
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
      subject: `Refund Processed — ${booking.ref}`,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Refund email error:', emailErr);
  }

  return res.status(200).json({
    success: true,
    refundId: stripeRefund.id,
    amount: stripeRefund.amount,
    cumulativeRefundAmount: cumulativeRefundCents,
    paymentStatus,
    status: stripeRefund.status,
    payoutReviewRequired,
  });
}
