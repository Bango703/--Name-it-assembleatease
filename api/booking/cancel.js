import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';

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
  if (booking.status === 'completed' || booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Cannot cancel a ' + booking.status + ' booking' });
  }

  // ── Stripe: release hold or refund deposit ──────────────
  let refundAmount = 0;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      if (booking.stripe_payment_intent_id && booking.payment_status === 'authorized') {
        // Cancel the uncaptured PaymentIntent — no charge to customer
        await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);

      } else if (booking.payment_status === 'deposit_paid') {
        // Refund the deposit that was already captured
        const depositIntentId = booking.stripe_deposit_intent_id || booking.stripe_payment_intent_id;
        if (depositIntentId) {
          const refund = await stripe.refunds.create({
            payment_intent: depositIntentId,
            metadata: { bookingRef: booking.ref, reason: 'owner_cancelled' },
          });
          refundAmount = refund.amount;
        }
      }
    } catch (stripeErr) {
      console.error('Stripe cancel/refund error:', stripeErr);
      // Log but do not block cancellation — owner can handle payment manually
    }
  }

  const { error: updateErr } = await sb
    .from('bookings')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason || null })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Cancel update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
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
           A full refund of <strong>$${(refundAmount / 100).toFixed(2)}</strong> has been processed and will appear on your card within 5–10 business days.
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

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'cancelled' }, refundAmount });
}
