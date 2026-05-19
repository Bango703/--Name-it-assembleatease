import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, date, time, address, service, notifyCustomer } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (fetchErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (['completed', 'cancelled', 'declined'].includes(booking.status)) {
    return res.status(400).json({ error: 'Cannot edit a ' + booking.status + ' booking' });
  }

  const updates = {};
  if (date)    updates.date    = date;
  if (time)    updates.time    = time;
  if (address) updates.address = address;
  if (service) updates.service = service;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const { error: updateErr } = await sb.from('bookings').update(updates).eq('id', bookingId);
  if (updateErr) {
    console.error('Edit booking error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Notify customer of changes if requested
  if (notifyCustomer && booking.customer_email) {
    try {
      const changed = [];
      if (date && date !== booking.date) changed.push('Date updated to <strong>' + esc(date) + '</strong>');
      if (time && time !== booking.time) changed.push('Time updated to <strong>' + esc(time) + '</strong>');
      if (address && address !== booking.address) changed.push('Address updated to <strong>' + esc(address) + '</strong>');
      if (service && service !== booking.service) changed.push('Service updated to <strong>' + esc(service) + '</strong>');

      if (changed.length) {
        const html = buildStatusEmail({
          customerName: booking.customer_name,
          ref: booking.ref,
          status: 'UPDATED',
          statusColor: '#1e40af',
          statusBg: '#dbeafe',
          headline: 'Your booking has been updated.',
          bodyHtml: `<p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">We've made the following changes to your booking:</p>
            <ul style="margin:0 0 20px;padding-left:1.25rem;font-size:14px;color:#52525b;line-height:1.9">${changed.map(c => '<li>' + c + '</li>').join('')}</ul>
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or call us at (737) 290-6129.</p>`,
        });
        await sendEmail({
          to: booking.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: 'Your booking has been updated — ' + booking.ref,
          html,
          replyTo: ownerEmail(),
        });
      }
    } catch (e) { console.error('Edit booking notify error:', e); }
  }

  console.log(JSON.stringify({ audit: true, action: 'edit_booking', actor: 'owner', bookingId, updates, timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: true });
}
