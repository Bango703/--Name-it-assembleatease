import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';

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
      status: 'UNABLE TO FULFIL',
      statusColor: '#71717a',
      statusBg: '#f4f4f5',
      headline: `We're sorry, ${esc(booking.customer_name)} — we can't take this one.`,
      bodyHtml: `
        <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Unfortunately we are not able to accommodate your request for <strong>${esc(booking.service)}</strong> at this time. No charge has been made to your card.</p>
        ${reasonHtml}
        <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">We'd love to help you on another date or with a different service. Feel free to submit a new booking and we'll do our best to make it work.</p>
        <p style="margin:0;font-size:14px;color:#52525b;line-height:1.7">We apologize for any inconvenience and appreciate your understanding.</p>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your Booking Request — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Decline email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'closedlost').catch(e => console.error('HubSpot decline stage error:', e));
  }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'declined' } });
}
