import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, date, time, address, service, notifyCustomer, totalPrice, quoteNote } = req.body;
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
  if (typeof totalPrice === 'number' && totalPrice >= 0) updates.total_price = totalPrice;

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const { error: updateErr } = await sb.from('bookings').update(updates).eq('id', bookingId);
  if (updateErr) {
    console.error('Edit booking error:', updateErr);
    return res.status(500).json({ error: 'Failed to update booking' });
  }

  // Notify customer of changes if requested
  if (notifyCustomer && booking.customer_email) {
    try {
      // Quote notification — when a price is being set for the first time
      const isQuote = typeof totalPrice === 'number' && totalPrice > 0 && (!booking.total_price || booking.total_price === 0);

      if (isQuote) {
        const quoteDollars = (totalPrice / 100).toFixed(2);
        const html = buildStatusEmail({
          customerName: booking.customer_name,
          ref: booking.ref,
          status: 'QUOTE READY',
          statusColor: '#92400e',
          statusBg: '#fef3c7',
          headline: `Your custom quote is ready, ${esc(booking.customer_name)}!`,
          bodyHtml: `
            <p style="margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Your Quote</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.date || 'TBD')}</td></tr>
              <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Address</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${esc(booking.address || 'TBD')}</td></tr>
              <tr><td style="padding:10px 0;color:#71717a">Quote Total</td><td style="padding:10px 0;font-weight:800;font-size:18px;color:#065f46">$${esc(quoteDollars)}</td></tr>
            </table>
            ${quoteNote ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:16px"><tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">${esc(quoteNote)}</td></tr></table>` : ''}
            <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or call us at (737) 290-6129.</p>`,
        });
        await sendEmail({
          to: booking.customer_email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Your quote is ready — ${booking.ref}`,
          html,
          replyTo: ownerEmail(),
        });
      } else {
        const changed = [];
        if (date && date !== booking.date) changed.push('Date updated to <strong>' + esc(date) + '</strong>');
        if (time && time !== booking.time) changed.push('Time updated to <strong>' + esc(time) + '</strong>');
        if (address && address !== booking.address) changed.push('Address updated to <strong>' + esc(address) + '</strong>');
        if (service && service !== booking.service) changed.push('Service updated to <strong>' + esc(service) + '</strong>');
        if (typeof totalPrice === 'number' && totalPrice !== booking.total_price) {
          changed.push('Price updated to <strong>$' + (totalPrice / 100).toFixed(2) + '</strong>');
        }

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
      }
    } catch (e) { console.error('Edit booking notify error:', e); }
  }

  console.log(JSON.stringify({ audit: true, action: 'edit_booking', actor: 'owner', bookingId, updates, timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: true });
}
