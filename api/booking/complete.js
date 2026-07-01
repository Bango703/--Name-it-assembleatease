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
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    return res.status(400).json({ error: 'Booking already completed. Payment already captured.' });
  }
  if (booking.payment_status === 'captured') {
    return res.status(400).json({ error: 'Payment already captured for this booking.' });
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

  // ── Stripe: capture payment (or charge balance for deposit jobs) ──
  let amountCharged = 0;
  let actualStripeFee = null; // actual Stripe fee (cents) from the balance transaction, if captured
  const captureRequired = booking.payment_status === 'authorized' || booking.payment_status === 'deposit_paid';
  if (captureRequired && !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      error: 'Payment capture configuration is unavailable. Booking was not completed.',
      code: 'CAPTURE_CONFIGURATION_UNAVAILABLE',
    });
  }

  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      if (booking.stripe_payment_intent_id && booking.payment_status === 'authorized') {
        // Shared with assembler-complete.js so owner/Easer races cannot create
        // two distinct Stripe capture attempts for the same booking.
        const idempotencyKey = `booking-complete-capture-${booking.id}`;
        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_complete_owner',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processing',
          metadata: { ref: booking.ref },
        });

        const captured = await stripe.paymentIntents.capture(
          booking.stripe_payment_intent_id,
          { expand: ['latest_charge.balance_transaction'] },
          { idempotencyKey },
        );
        amountCharged = captured.amount_received;
        const _bt = captured.latest_charge && captured.latest_charge.balance_transaction;
        if (_bt && typeof _bt.fee === 'number') actualStripeFee = _bt.fee;

        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_complete_owner',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { ref: booking.ref, amountCharged: amountCharged || 0 },
        });

      } else if (booking.payment_status === 'deposit_paid' && booking.stripe_customer_id && booking.stripe_payment_method_id) {
        // Deposit already taken — charge the remaining 75% off-session
        const balanceCents = (booking.total_price || 0) - (booking.deposit_amount || 0);
        if (balanceCents > 0) {
          const idempotencyKey = `booking-complete-balance-${booking.id}`;
          await writeFinancialAudit(sb, {
            eventType: 'capture_recovery_attempt',
            eventSource: 'booking_complete_owner',
            bookingId: booking.id,
            paymentIntentId: booking.stripe_payment_intent_id,
            idempotencyKey,
            status: 'processing',
            metadata: { ref: booking.ref, balanceCents },
          });

          const balancePI = await stripe.paymentIntents.create({
            amount: balanceCents,
            currency: 'usd',
            customer: booking.stripe_customer_id,
            payment_method: booking.stripe_payment_method_id,
            confirm: true,
            off_session: true,
            metadata: { bookingRef: booking.ref, bookingId: booking.id, type: 'customer_booking_balance' },
            description: `Balance — ${booking.service} — ${booking.customer_name}`,
          }, { idempotencyKey });
          amountCharged = (booking.deposit_amount || 0) + (balancePI.amount_received || balanceCents);

          await writeFinancialAudit(sb, {
            eventType: 'capture_recovery_attempt',
            eventSource: 'booking_complete_owner',
            bookingId: booking.id,
            paymentIntentId: balancePI.id,
            idempotencyKey,
            status: 'processed',
            metadata: { ref: booking.ref, amountCharged: amountCharged || 0 },
          });
        } else {
          amountCharged = booking.deposit_amount || 0;
        }
      }
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
          subject: `⚠️ Payment Capture Failed — ${booking.ref}`,
          html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #fecaca"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#991b1b">Payment Capture Failed</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.6">The automatic payment capture for booking <strong>${esc(booking.ref)}</strong> failed. The job has been marked complete but payment was NOT collected. Manual resolution required.</p>
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
  let isMember = false;
  if (booking.assembler_id) {
    const { data: asmProf } = await sb.from('profiles').select('has_membership').eq('id', booking.assembler_id).single();
    isMember = asmProf?.has_membership === true;
  }
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: finalAmountCharged,
    taxCents: booking.tax_amount || 0,
    isMember,
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
  const { error: updateErr, data: updatedRows } = await sb
    .from('bookings')
    .update({
      status: BOOKING_STATUS.COMPLETED,
      completed_at: new Date().toISOString(),
      payment_status: 'captured',
      payment_captured_at: new Date().toISOString(),
      amount_charged: finalAmountCharged,
      platform_fee_pct: PLATFORM_FEE_PCT,
      platform_fee: platformFee,
      assembler_due: assemblerDue,
      payout_status: payoutStatus,
    })
    .eq('id', booking.id)
    .neq('status', BOOKING_STATUS.COMPLETED)
    .neq('payment_status', 'captured')
    .select('id');

  if (updateErr) {
    console.error('Complete update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }
  if (!updatedRows || updatedRows.length === 0) {
    const { data: current } = await sb
      .from('bookings')
      .select('id, ref, status, payment_status, payout_status, stripe_transfer_id, stripe_destination_account_id')
      .eq('id', booking.id)
      .maybeSingle();

    if (current?.status === BOOKING_STATUS.COMPLETED || current?.payment_status === 'captured') {
      return res.status(200).json({
        success: true,
        alreadyCompleted: true,
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

  // Store the actual Stripe fee (best-effort, non-fatal — survives a not-yet-applied
  // migration where the stripe_fee column is missing).
  if (actualStripeFee != null) {
    try {
      const { error: feeErr } = await sb.from('bookings').update({ stripe_fee: actualStripeFee }).eq('id', booking.id);
      if (feeErr) console.warn('stripe_fee store skipped (run migration 011):', feeErr.message || feeErr);
    } catch (e) { console.warn('stripe_fee store error:', e && (e.message || e)); }
  }

  // Keep owner-complete aligned with assembler-complete: payouts are held first,
  // then released by cron/manual payout after the review window. This preserves a
  // single payout source of truth and avoids immediate-transfer drift.
  if (booking.assembler_id && assemblerDue > 0) {
    connectPayout = isStripeConnectEnabled()
      ? { status: 'scheduled', note: 'Releases about 48 hours after completion once payout setup is ready.' }
      : { status: 'pending_manual', reason: 'connect-disabled' };
  }

  // Increment assembler's completed_jobs atomically via RPC (prevents lost-update race
  // between simultaneous owner + assembler complete calls).
  // Requires: CREATE FUNCTION increment_completed_jobs(user_id UUID) in Supabase (see migrations).
  if (booking.assembler_id) {
    try {
      const { error: rpcErr } = await sb.rpc('increment_completed_jobs', { user_id: booking.assembler_id });
      if (rpcErr) {
        console.warn('increment_completed_jobs RPC missing — run migration 002 in Supabase.');
        const { data: prof } = await sb.from('profiles').select('completed_jobs').eq('id', booking.assembler_id).single();
        await sb.from('profiles').update({ completed_jobs: (prof?.completed_jobs || 0) + 1 }).eq('id', booking.assembler_id);
      }
    } catch (countErr) {
      console.error('completed_jobs increment error:', countErr);
    }
    // Job is done — release the Easer's daily slot
    adjustActiveJobs(sb, booking.assembler_id, -1).catch(() => {});
  }
  try {
    const reviewUrl = `https://www.assembleatease.com/review?ref=${encodeURIComponent(booking.ref)}&email=${encodeURIComponent(booking.customer_email)}`;
    const amountDisplay = finalAmountCharged > 0 ? `$${(finalAmountCharged / 100).toFixed(2)}` : null;
    const receiptBlock = amountDisplay ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px">
        <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#166534">Payment Receipt</p>
        <p style="margin:0 0 12px;font-size:28px;font-weight:700;color:#065f46">${amountDisplay}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#166534">
          <tr><td style="padding:3px 0;width:130px">Service</td><td style="padding:3px 0;font-weight:600">${esc(booking.service)}</td></tr>
          <tr><td style="padding:3px 0">Reference</td><td style="padding:3px 0;font-weight:600">${esc(booking.ref)}</td></tr>
          <tr><td style="padding:3px 0">Payment method</td><td style="padding:3px 0">Card on file</td></tr>
          <tr><td style="padding:3px 0">Status</td><td style="padding:3px 0;font-weight:700">Charged ✓</td></tr>
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
        ${receiptBlock}
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px;text-align:center">
          <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1e40af">Did we do a good job?</p>
          <p style="margin:0 0 16px;font-size:13px;color:#1e40af;line-height:1.6">A quick review helps other Austin homeowners find trusted help — it takes 30 seconds and your booking is pre-filled.</p>
          <a href="${reviewUrl}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Leave a Review &#11088;</a>
        </td></tr></table>
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
  return res.status(200).json({
    success: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
    payout: connectPayout,
  });
}
