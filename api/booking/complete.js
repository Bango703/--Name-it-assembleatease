import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';

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
  if (booking.status === 'completed') {
    return res.status(400).json({ error: 'Booking already completed. Payment already captured.' });
  }
  if (booking.payment_status === 'captured') {
    return res.status(400).json({ error: 'Payment already captured for this booking.' });
  }
  if (booking.status !== 'confirmed') {
    return res.status(400).json({ error: 'Only confirmed bookings can be completed. Current status: ' + booking.status });
  }

  // ── Stripe: capture payment (or charge balance for deposit jobs) ──
  let amountCharged = 0;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      if (booking.stripe_payment_intent_id && booking.payment_status === 'authorized') {
        // Capture the full held amount
        const captured = await stripe.paymentIntents.capture(booking.stripe_payment_intent_id);
        amountCharged = captured.amount_received;

      } else if (booking.payment_status === 'deposit_paid' && booking.stripe_customer_id && booking.stripe_payment_method_id) {
        // Deposit already taken — charge the remaining 75% off-session
        const balanceCents = (booking.total_price || 0) - (booking.deposit_amount || 0);
        if (balanceCents > 0) {
          const balancePI = await stripe.paymentIntents.create({
            amount: balanceCents,
            currency: 'usd',
            customer: booking.stripe_customer_id,
            payment_method: booking.stripe_payment_method_id,
            confirm: true,
            off_session: true,
            metadata: { bookingRef: booking.ref, bookingId: booking.id, type: 'customer_booking_balance' },
            description: `Balance — ${booking.service} — ${booking.customer_name}`,
          });
          amountCharged = (booking.deposit_amount || 0) + (balancePI.amount_received || balanceCents);
        } else {
          amountCharged = booking.deposit_amount || 0;
        }
      }
    } catch (stripeErr) {
      console.error('Stripe capture error:', stripeErr);
      // Continue — don't block job completion on payment error; owner can resolve manually
    }
  }

  const finalAmountCharged = amountCharged || booking.total_price || 0;

  // Platform revenue split — configurable via PLATFORM_FEE_PCT env var (default 20%)
  const PLATFORM_FEE_PCT = Math.min(100, Math.max(0, parseInt(process.env.PLATFORM_FEE_PCT || '20')));
  const platformFee = Math.round(finalAmountCharged * PLATFORM_FEE_PCT / 100);
  const assemblerDue = finalAmountCharged - platformFee;

  const { error: updateErr } = await sb
    .from('bookings')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      payment_status: 'captured',
      payment_captured_at: new Date().toISOString(),
      amount_charged: finalAmountCharged,
      platform_fee_pct: PLATFORM_FEE_PCT,
      platform_fee: platformFee,
      assembler_due: assemblerDue,
    })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Complete update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Increment assembler's completed_jobs count
  if (booking.assembler_id) {
    try {
      const { data: prof } = await sb
        .from('profiles')
        .select('completed_jobs')
        .eq('id', booking.assembler_id)
        .single();
      await sb
        .from('profiles')
        .update({ completed_jobs: (prof?.completed_jobs || 0) + 1 })
        .eq('id', booking.assembler_id);
    } catch (countErr) {
      console.error('completed_jobs increment error:', countErr);
      // Non-fatal — don't block the response
    }
  }
  try {
    const reviewUrl = process.env.GOOGLE_REVIEW_URL || 'https://www.assembleatease.com';
    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'COMPLETED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Job complete! Thank you, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> service has been completed. We hope you're happy with the work!</p>
        ${finalAmountCharged > 0 ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;font-size:14px;color:#065f46;line-height:1.6"><strong>Amount charged: $${(finalAmountCharged/100).toFixed(2)}</strong> — This has been processed to your card on file. You will receive a Stripe receipt at ${esc(booking.customer_email)}.</td></tr></table>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px;text-align:center">
          <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1e40af">Enjoyed the service?</p>
          <p style="margin:0 0 16px;font-size:13px;color:#1e40af;line-height:1.6">A quick review helps other Austin homeowners find reliable help.</p>
          <a href="${esc(reviewUrl)}" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Leave a Review &#9733;</a>
        </td></tr></table>
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">Need anything else? We'd love to help again anytime.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Job Complete — How did we do? ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Complete email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedwon').catch(e => console.error('HubSpot complete stage error:', e));
  }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'completed' } });
}
