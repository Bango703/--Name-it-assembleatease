import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { updateDealStage } from '../_hubspot.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, ref } = req.body;
  if (!bookingId && !ref) return res.status(400).json({ error: 'bookingId or ref is required' });

  const sb = getSupabase();

  // Fetch the booking
  let query = sb.from('bookings').select('*');
  if (bookingId) query = query.eq('id', bookingId);
  else query = query.eq('ref', ref);
  const { data: booking, error: fetchErr } = await query.single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== 'pending') return res.status(400).json({ error: 'Booking is not pending. Current status: ' + booking.status });

  // Update status
  const { error: updateErr } = await sb
    .from('bookings')
    .update({ status: 'confirmed', confirmed_at: new Date().toISOString(), confirmed_by: 'owner' })
    .eq('id', booking.id);

  if (updateErr) {
    console.error('Confirm update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Send confirmation email to customer
  try {
    const html = buildStatusEmail({
      customerName: booking.customer_name,
      ref: booking.ref,
      status: 'CONFIRMED',
      statusColor: '#065f46',
      statusBg: '#d1fae5',
      headline: `Your booking is confirmed, ${esc(booking.customer_name)}!`,
      bodyHtml: `
        <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Appointment Details</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.date)}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.time)}</td></tr>
          <tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(booking.address)}</td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
          <strong style="color:#1a1a1a">Cancellation policy:</strong> We ask for at least 24 hours' notice to cancel or reschedule.
        </td></tr></table>`,
    });

    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Booking Confirmed — ' + booking.ref,
      html,
      replyTo: ownerEmail(),
    });
  } catch (emailErr) {
    console.error('Confirm email error:', emailErr);
  }

  // Non-blocking HubSpot stage update
  if (booking.hubspot_deal_id) {
    updateDealStage(booking.hubspot_deal_id, 'appointmentscheduled').catch(e => console.error('HubSpot confirm stage error:', e));
  }

  return res.status(200).json({ success: true, booking: { id: booking.id, ref: booking.ref, status: 'confirmed' } });
}
