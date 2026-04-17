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
  if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending. Current status: ' + booking.status });

  const { error: updateErr } = await sb
    .from('bookings')
    .update({ status: 'declined', declined_at: new Date().toISOString(), decline_reason: reason || null })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Decline update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Send decline email to customer
  try {
    const reasonHtml = reason
      ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px">
           <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a">Reason</p>
           <p style="margin:0;font-size:14px;color:#1a1a1a;line-height:1.6">${esc(reason)}</p>
         </td></tr></table>`
      : '';

    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'DECLINED',
      statusColor: '#991b1b',
      statusBg: '#fee2e2',
      headline: `We're unable to fulfill your booking, ${esc(booking.customer_name)}.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">We're sorry, but we're unable to accommodate this request at this time. We apologize for the inconvenience.</p>
        ${reasonHtml}
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">If you'd like to submit a new request for a different date or service, we'd be happy to help.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Booking Update — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Decline email error:', emailErr);
  }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'declined' } });
}
