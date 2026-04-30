import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';

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
  if (booking.payment_status === 'refunded') {
    return res.status(400).json({ error: 'Booking has already been refunded' });
  }
  if (booking.payment_status === 'authorized') {
    return res.status(400).json({ error: 'This payment has not been captured yet — the card hold has not been charged. Cancel the booking instead to release the hold on the customer\'s card.' });
  }

  const refundAmountCents = amount ? parseInt(amount, 10) : (booking.amount_charged || null);
  if (!refundAmountCents || refundAmountCents <= 0) {
    return res.status(400).json({ error: 'Invalid refund amount' });
  }

  let stripeRefund;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    stripeRefund = await stripe.refunds.create({
      payment_intent: booking.stripe_payment_intent_id,
      amount: refundAmountCents,
      reason: 'requested_by_customer',
    });
  } catch (stripeErr) {
    console.error('Stripe refund error:', stripeErr);
    return res.status(500).json({ error: stripeErr?.raw?.message || stripeErr.message || 'Refund failed' });
  }

  // Update booking record
  const { error: updateErr } = await sb.from('bookings').update({
    payment_status: 'refunded',
    refund_id: stripeRefund.id,
    refund_amount: stripeRefund.amount,
    refunded_at: new Date().toISOString(),
    refund_reason: reason?.trim() || null,
  }).eq('id', booking.id);

  if (updateErr) console.error('Refund DB update error:', updateErr);

  // #7 — Send customer refund email
  try {
    const refundDisplay = `$${(stripeRefund.amount / 100).toFixed(2)}`;
    const totalDisplay = booking.amount_charged ? `$${(booking.amount_charged / 100).toFixed(2)}` : null;
    const isPartial = booking.amount_charged && stripeRefund.amount < booking.amount_charged;

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
        <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Refunds typically appear within 5–10 business days depending on your bank. Questions? Contact <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a>.</p>`,
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
    status: stripeRefund.status,
  });
}
