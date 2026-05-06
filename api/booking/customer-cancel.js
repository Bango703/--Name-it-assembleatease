import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';

/**
 * POST /api/booking/customer-cancel
 * Customer self-service booking cancellation.
 * Requires Bearer JWT (customer session).
 * Body: { bookingId }
 * - Free if cancelled 24+ hrs before appointment
 * - 50% fee if cancelled within 24 hrs of appointment
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Verify this booking belongs to the requesting customer
  if (booking.customer_id && booking.customer_id !== user.id) {
    return res.status(403).json({ error: 'This booking does not belong to your account' });
  }

  if (booking.status === 'completed') {
    return res.status(400).json({ error: 'Completed bookings cannot be cancelled' });
  }
  if (booking.status === 'cancelled') {
    return res.status(400).json({ error: 'Booking is already cancelled' });
  }

  // Determine if within 24hr cancellation window of appointment
  let withinWindow = false;
  try {
    const apptDate = new Date(booking.date);
    const slotStart = (booking.time || '').split('-')[0].trim();
    const match = slotStart.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (match) {
      let h = parseInt(match[1], 10);
      const m = parseInt(match[2], 10);
      const mer = match[3].toUpperCase();
      if (mer === 'PM' && h !== 12) h += 12;
      if (mer === 'AM' && h === 12) h = 0;
      apptDate.setHours(h, m, 0, 0);
    }
    const hoursAway = (apptDate.getTime() - Date.now()) / 3600000;
    withinWindow = hoursAway >= 0 && hoursAway < 24;
  } catch (e) { console.error('Date parse error:', e); }

  // Stripe: release hold or charge cancellation fee
  let feeCaptured = 0;
  if (process.env.STRIPE_SECRET_KEY && booking.stripe_payment_intent_id && booking.payment_status === 'authorized') {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      if (withinWindow && (booking.total_price || 0) > 0) {
        const feeCents = Math.round((booking.total_price || 0) * 0.5);
        await stripe.paymentIntents.capture(booking.stripe_payment_intent_id, { amount_to_capture: feeCents });
        feeCaptured = feeCents;
      } else {
        await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id);
      }
    } catch (e) { console.error('Stripe cancel error:', e); }
  }

  const { error: updateErr } = await sb.from('bookings').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancel_reason: 'Cancelled by customer',
    cancellation_fee: feeCaptured || null,
  }).eq('id', booking.id);

  if (updateErr) {
    console.error('Customer cancel update failed:', updateErr);
    return res.status(500).json({ error: 'Unable to process cancellation. Please call us at (737) 290-6129.' });
  }

  // Email customer
  try {
    const feeHtml = feeCaptured > 0
      ? `<p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
           A late-cancellation fee of <strong>$${(feeCaptured/100).toFixed(2)}</strong> (50% of total) was charged as this cancellation was within 24 hours of your appointment.
         </p>`
      : `<p style="margin:0 0 16px;font-size:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;color:#166534">
           No charge — your card hold has been released.
         </p>`;

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Booking Cancelled — ${booking.ref}`,
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: 'CANCELLED',
        statusColor: '#71717a',
        statusBg: '#f4f4f5',
        headline: `Your booking has been cancelled.`,
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your booking for <strong>${esc(booking.service)}</strong> on <strong>${esc(booking.date)}</strong> has been cancelled as requested.</p>
          ${feeHtml}
          <p style="margin:0;font-size:14px;color:#52525b">Ready to rebook? <a href="https://www.assembleatease.com/book" style="color:#0097a7;font-weight:600">Schedule a new appointment</a> anytime.</p>`,
      }),
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Customer cancel email error:', e); }

  // Notify owner
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Customer Cancelled — ${booking.ref}`,
      html: `<p>Customer <strong>${esc(booking.customer_name)}</strong> cancelled booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p>
<p>Job date: ${esc(booking.date)} at ${esc(booking.time)}${feeCaptured > 0 ? ' — Cancellation fee of $' + (feeCaptured/100).toFixed(2) + ' charged.' : ' — No fee charged (>24hr notice).'}</p>`,
    });
  } catch (e) { console.error('Owner cancel notify error:', e); }

  console.log(JSON.stringify({ audit: true, action: 'booking_cancel', actor: 'customer', customerId: user.id, bookingId: booking.id, ref: booking.ref, feeCaptured, withinWindow, timestamp: new Date().toISOString() }));
  return res.status(200).json({ success: true, feeCaptured, withinWindow });
}
