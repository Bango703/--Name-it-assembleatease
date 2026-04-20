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

  // ── Determine if within 24hr cancellation window ─────────────────────────
  const waiveFee = req.body.waiveFee === true;
  let withinCancellationWindow = false;
  try {
    const appointmentDate = new Date(booking.date);
    const slotStart = (booking.time || '').split('-')[0].trim();
    const timeMatch = slotStart.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      const meridiem = timeMatch[3].toUpperCase();
      if (meridiem === 'PM' && h !== 12) h += 12;
      if (meridiem === 'AM' && h === 12) h = 0;
      appointmentDate.setHours(h, m, 0, 0);
    }
    const hoursAway = (appointmentDate.getTime() - Date.now()) / (1000 * 60 * 60);
    withinCancellationWindow = hoursAway >= 0 && hoursAway < 24;
  } catch (dateErr) {
    console.error('Cancellation window date parse error:', dateErr);
  }

  // ── Stripe: charge fee or release hold ────────────────────────────────────
  let refundAmount = 0;
  let feeCaptured = 0;
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

      if (booking.stripe_payment_intent_id && booking.payment_status === 'authorized') {
        if (!waiveFee && withinCancellationWindow && (booking.total_price || 0) > 0) {
          // Within 24hr window — capture 50% as cancellation fee
          const feeCents = Math.round((booking.total_price || 0) * 0.5);
          await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, {
            amount_to_capture: feeCents,
          });
          feeCaptured = feeCents;
        } else {
          // Outside window or fee waived — release hold entirely
          await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
        }
      } else if (booking.payment_status === 'deposit_paid') {
        // Deposit already captured — refund it
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
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: reason || null, cancellation_fee: feeCaptured || null })
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
           A full refund of <strong>$${(refundAmount / 100).toFixed(2)}</strong> has been processed and will appear on your card within 5&ndash;10 business days.
         </p>`
      : '';

    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 20px;font-size:14px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;">
           A cancellation fee of <strong>$${(feeCaptured / 100).toFixed(2)}</strong> (50% of booking total) was charged per our late-cancellation policy (within 24 hours of appointment).
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

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'cancelled' }, refundAmount, feeCaptured, withinCancellationWindow });
}
