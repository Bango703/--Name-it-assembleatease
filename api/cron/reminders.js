import { getSupabase } from '../_supabase.js';
import { sendEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * GET /api/cron/reminders
 * Runs hourly via Vercel cron.
 * Sends a 24-hour appointment reminder email to customers whose confirmed booking
 * is within the next 25 hours and has not yet received a reminder.
 *
 * Requires the `reminder_sent` boolean column on the bookings table.
 * If the column does not exist, run:
 *   ALTER TABLE bookings ADD COLUMN reminder_sent boolean DEFAULT false;
 */
export default async function handler(req, res) {
  // Only allow Vercel cron or internal calls
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // Find confirmed bookings with a date within the next 25 hours
  // and where reminder_sent is false (or null/missing)
  const now     = new Date();
  const in25h   = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // ISO date strings (YYYY-MM-DD) for date comparison
  const todayStr  = now.toISOString().slice(0, 10);
  const futureStr = in25h.toISOString().slice(0, 10);

  const { data: bookings, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_email, date, time, address')
    .eq('status', 'confirmed')
    .eq('reminder_sent', false)
    .gte('date', todayStr)
    .lte('date', futureStr);

  if (error) {
    console.error('Reminder cron query error:', error);
    return res.status(500).json({ error: 'Failed to query bookings' });
  }

  if (!bookings || bookings.length === 0) {
    return res.status(200).json({ ok: true, sent: 0 });
  }

  let sent = 0;
  const errors = [];

  for (const booking of bookings) {
    try {
      // Double-check the booking date is actually within 25 hours
      // (date column is YYYY-MM-DD — combined with time or assumed 9am)
      const bookingDatetime = new Date(`${booking.date}T${booking.time || '09:00'}:00`);
      const msUntil = bookingDatetime.getTime() - now.getTime();
      if (msUntil < 0 || msUntil > 25 * 60 * 60 * 1000) {
        // Outside window — skip
        continue;
      }

      const customerFirst = (booking.customer_name || 'there').split(' ')[0];
      const html = buildReminderEmail({ customerFirst, booking });

      await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Reminder: Your appointment is tomorrow — ${booking.ref}`,
        html,
        replyTo: 'service@assembleatease.com',
      });

      // Mark reminder sent
      await sb
        .from('bookings')
        .update({ reminder_sent: true })
        .eq('id', booking.id);

      sent++;
    } catch (e) {
      console.error(`Reminder error for booking ${booking.ref}:`, e);
      errors.push(booking.ref);
    }
  }

  return res.status(200).json({ ok: true, sent, errors: errors.length ? errors : undefined });
}

function buildReminderEmail({ customerFirst, booking }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7">
    <tr><td style="padding:20px 24px;text-align:center">
      <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
      <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7">
    <tr><td style="padding:28px 24px">
      <p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#1a1a1a">Your appointment is tomorrow, ${esc(customerFirst)}!</p>
      <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">Just a friendly reminder that your service appointment is coming up. Here are your booking details:</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:24px">
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Booking ref</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:13px">${esc(booking.ref)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service)}</td></tr>
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.date)}</td></tr>
        ${booking.time ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.time)}</td></tr>` : ''}
        ${booking.address ? `<tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(booking.address)}</td></tr>` : ''}
      </table>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px">
        <tr><td style="padding:14px 18px;font-size:13px;color:#52525b;line-height:1.6">
          Need to reschedule? Reply to this email at least 24 hours before your appointment and we'll do our best to accommodate you.
        </td></tr>
      </table>
    </td></tr>
  </table>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px">
    <tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
      AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
    </td></tr>
  </table>

</div>
</body></html>`;
}
