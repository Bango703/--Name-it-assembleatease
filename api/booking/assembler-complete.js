import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { logActivity } from './_activity.js';
import { writeFinancialAudit } from '../_financial-audit.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES, getPlatformFeePct, computeBookingSplit } from '../_source-of-truth.js';
import { getTransitionError } from './_workflow-engine.js';
import { isStripeConnectEnabled, getAssemblerConnectAccount } from '../_stripe-connect.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/booking/assembler-complete
 * The assigned assembler marks a job as done.
 * Requires Bearer JWT (assembler session token).
 * Body: { bookingId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify assembler JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();

  // Fetch booking
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Verify this assembler is assigned
  if (booking.assembler_id !== user.id) {
    return res.status(403).json({ error: 'You are not assigned to this booking' });
  }
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    return res.status(400).json({ error: 'Booking is already marked complete' });
  }
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status)) {
    return res.status(400).json({ error: 'Job must be active to mark complete' });
  }
  const transitionErr = getTransitionError(booking.status, BOOKING_STATUS.COMPLETED);
  if (transitionErr) {
    return res.status(400).json({ error: transitionErr });
  }
  if (!booking.assembler_accepted_at && !booking.assigned_at) {
    return res.status(400).json({ error: 'You must be assigned to this booking before marking it complete' });
  }

  // Require at least one completion photo — no exceptions
  const { data: evidenceRows } = await sb
    .from('booking_evidence')
    .select('id')
    .eq('booking_id', booking.id)
    .limit(1);
  if (!evidenceRows?.length) {
    return res.status(400).json({ error: 'A completion photo is required. Please upload a photo before marking this job complete.' });
  }

  // Block completion if no payment is authorized — applies to quote bookings
  // where the owner has not yet called /api/owner/quote-approve.
  if (!booking.stripe_payment_intent_id) {
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

  // ── Stripe: capture payment ──────────────────────────────────────────────
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
        // Shared with owner complete.js so owner/Easer races cannot create
        // two distinct Stripe capture attempts for the same booking.
        const idempotencyKey = `booking-complete-capture-${booking.id}`;
        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_complete_assembler',
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
        // Actual Stripe processing fee from the balance transaction (authoritative).
        const _bt = captured.latest_charge && captured.latest_charge.balance_transaction;
        if (_bt && typeof _bt.fee === 'number') actualStripeFee = _bt.fee;

        await writeFinancialAudit(sb, {
          eventType: 'capture_attempt',
          eventSource: 'booking_complete_assembler',
          bookingId: booking.id,
          paymentIntentId: booking.stripe_payment_intent_id,
          idempotencyKey,
          status: 'processed',
          metadata: { ref: booking.ref, amountCharged: amountCharged || 0 },
        });
      } else if (booking.payment_status === 'deposit_paid' && booking.stripe_customer_id && booking.stripe_payment_method_id) {
        const balanceCents = (booking.total_price || 0) - (booking.deposit_amount || 0);
        if (balanceCents > 0) {
          const idempotencyKey = `booking-complete-balance-${booking.id}`;
          await writeFinancialAudit(sb, {
            eventType: 'capture_recovery_attempt',
            eventSource: 'booking_complete_assembler',
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
            eventSource: 'booking_complete_assembler',
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
          subject: `⚠️ Payment Capture Failed — ${booking.ref}`,
          html: `<p>Payment capture failed for booking <strong>${esc(booking.ref)}</strong> after assembler marked job complete.</p>
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
  // the fee/payout base. Members 25% / non-members 30% (see _source-of-truth.js).
  const { data: easerProf } = await sb.from('profiles').select('has_membership').eq('id', user.id).single();
  const isMember = easerProf?.has_membership === true;
  const split = computeBookingSplit(finalAmount, isMember, { taxCents: booking.tax_amount || 0 });
  const PLATFORM_FEE_PCT = split.feePct;
  const platformFee      = split.platformFeeCents;
  const assemblerDue     = split.assemblerDueCents;
  const taxCents         = split.taxCents;
  const revenueBaseCents = split.revenueBaseCents;
  let connectPayout = { status: 'disabled' };

  // ── Update booking (atomic guard — prevents double-complete race) ────────
  const { error: updateErr, data: updatedRows } = await sb.from('bookings').update({
    status: BOOKING_STATUS.COMPLETED,
    completed_at: new Date().toISOString(),
    assembler_accepted_at: booking.assembler_accepted_at || new Date().toISOString(),
    payment_status: 'captured',
    payment_captured_at: new Date().toISOString(),
    amount_charged: finalAmount,
    platform_fee_pct: PLATFORM_FEE_PCT,
    platform_fee: platformFee,
    assembler_due: assemblerDue,
    completed_by: 'assembler',
    payout_status: 'pending',
  })
  .eq('id', booking.id)
  .neq('status', BOOKING_STATUS.COMPLETED)
  .neq('payment_status', 'captured')
  .select('id');

  if (updateErr) {
    console.error('Assembler-complete update error:', updateErr);
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
      error: 'Completion capture succeeded, but booking state was changed by another request. Contact AssembleAtEase before retrying.',
      code: 'COMPLETION_STATE_RACE',
    });
  }

  // Store the actual Stripe fee (best-effort, non-fatal). Separate from the main
  // update so a not-yet-applied migration (column missing) can never block completion.
  if (actualStripeFee != null) {
    try {
      const { error: feeErr } = await sb.from('bookings').update({ stripe_fee: actualStripeFee }).eq('id', booking.id);
      if (feeErr) console.warn('stripe_fee store skipped (run migration 011):', feeErr.message || feeErr);
    } catch (e) { console.warn('stripe_fee store error:', e && (e.message || e)); }
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
    const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://www.assembleatease.com';
    const amountDisplay = finalAmount > 0 ? `$${(finalAmount / 100).toFixed(2)}` : null;

    // Completion photo — visual proof of the finished work (signed URL, 30-day expiry).
    let photoBlock = '';
    try {
      const { data: photoRows } = await sb
        .from('booking_evidence')
        .select('storage_path, evidence_type, created_at')
        .eq('booking_id', booking.id)
        .order('created_at', { ascending: false });
      const path = (photoRows || []).find(r => r.evidence_type === 'completion_photo')?.storage_path
        || (photoRows || [])[0]?.storage_path;
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
          <tr><td style="padding:3px 0">Status</td><td style="padding:3px 0;font-weight:700">Charged ✓</td></tr>
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
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px;text-align:center">
            <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1e40af">Did we do a good job?</p>
            <p style="margin:0 0 16px;font-size:13px;color:#1e40af;line-height:1.6">A quick Google review helps Austin homeowners find trusted help — takes 30 seconds.</p>
            <a href="${esc(reviewUrl)}" style="display:inline-block;background:#00BFFF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Leave a Review &#9733;</a>
          </td></tr></table>`,
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
        subject: `Job Complete — Payout Summary for ${booking.ref}`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:20px;font-weight:700;color:#065f46">&#10003; Job Marked Complete</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b">Booking <strong>${esc(booking.ref)}</strong> &mdash; ${esc(booking.service)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:16px"><tr><td style="padding:16px 20px">
      <table width="100%" style="font-size:14px">
        <tr><td style="padding:4px 0;color:#166534">Total charged to customer</td><td style="padding:4px 0;text-align:right;font-weight:600">$${(finalAmount/100).toFixed(2)}</td></tr>
        ${taxCents > 0 ? `<tr><td style="padding:4px 0;color:#166534">Sales tax (paid to the state)</td><td style="padding:4px 0;text-align:right;color:#71717a">&minus;$${(taxCents/100).toFixed(2)}</td></tr>
        <tr><td style="padding:4px 0;color:#166534">Service amount</td><td style="padding:4px 0;text-align:right;font-weight:600">$${(revenueBaseCents/100).toFixed(2)}</td></tr>` : ''}
        <tr><td style="padding:4px 0;color:#166534">Platform fee (${PLATFORM_FEE_PCT}% of service amount)</td><td style="padding:4px 0;text-align:right;color:#dc2626">&minus;$${(platformFee/100).toFixed(2)}</td></tr>
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

  return res.status(200).json({
    success: true,
    booking: { id: booking.id, ref: booking.ref, status: BOOKING_STATUS.COMPLETED },
    payout: connectPayout,
  });
}
