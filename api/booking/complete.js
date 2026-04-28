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
    <p style="font-size:13px;color:#71717a;line-height:1.6">Log in to the Stripe dashboard to manually capture or re-attempt payment. If the card was declined, contact the customer directly at <a href="mailto:${esc(booking.customer_email)}" style="color:#0097a7">${esc(booking.customer_email)}</a>.</p>
  </td></tr></table>
</div></body></html>`,
        });
      } catch (alertErr) { console.error('Capture failure alert error:', alertErr); }
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
      headline: `Your job is complete, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> service has been completed. Thank you for choosing AssembleAtEase!</p>
        ${receiptBlock}
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;margin-bottom:20px"><tr><td style="padding:18px 20px;text-align:center">
          <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#1e40af">Did we do a good job?</p>
          <p style="margin:0 0 16px;font-size:13px;color:#1e40af;line-height:1.6">A quick Google review helps other Austin homeowners find trusted help — it takes 30 seconds.</p>
          <a href="${esc(reviewUrl)}" style="display:inline-block;background:#0097a7;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600">Leave a Review &#9733;</a>
        </td></tr></table>
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">Need help with anything else? We're always here — <a href="https://www.assembleatease.com/book" style="color:#0097a7;font-weight:600">book your next service</a> anytime.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Payment Receipt & Job Complete — ${booking.ref}`,
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
