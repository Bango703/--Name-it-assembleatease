import { getSupabase } from '../_supabase.js';
import { formatAppointmentDate, formatAppointmentDateShort, formatSlotShort } from '../booking/_appt-date.js';
import { sendEmail, ownerEmail, esc, formatAddress } from '../_email.js';
import { sendSms } from '../_sms.js';
import { logCron } from './_cron-logger.js';
import { appointmentTimestampMs } from '../booking/_appt-date.js';

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
  if (!cronSecret || authHeader !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const t = Date.now();
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
    .select('id, ref, service, customer_name, customer_email, date, time, address, status, reminder_sent, assembler_id, assembler_name, assembler_accepted_at')
    .eq('status', 'confirmed')
    .eq('reminder_sent', false)
    .gte('date', todayStr)
    .lte('date', futureStr);

  if (error) {
    console.error('Reminder cron query error:', error);
    return res.status(500).json({ error: 'Failed to query bookings' });
  }

  let sent = 0;
  let reconciled = 0;
  const errors = [];

  for (const booking of bookings || []) {
    try {
      // Double-check the booking date is actually within 25 hours
      // (date column is YYYY-MM-DD — combined with time or assumed 9am)
      const bookingDatetimeMs = appointmentTimestampMs(booking.date, booking.time || '9:00 AM');
      if (bookingDatetimeMs == null) {
        errors.push({ ref: booking.ref, error: 'Unrecognized appointment time' });
        continue;
      }
      const msUntil = bookingDatetimeMs - now.getTime();
      if (msUntil < 0 || msUntil > 25 * 60 * 60 * 1000) {
        // Outside window — skip
        continue;
      }

      const customerFirst = (booking.customer_name || 'there').split(' ')[0];
      const html = buildReminderEmail({ customerFirst, booking });

      const emailResult = await sendEmail({
        to: booking.customer_email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Reminder: Your appointment is tomorrow — ${booking.ref}`,
        html,
        replyTo: 'service@assembleatease.com',
        meta: {
          bookingId: booking.id,
          notificationType: 'reminder',
          recipientType: 'customer',
          disableDailyCap: true,
        },
      });
      if (!emailResult?.ok) {
        errors.push({ ref: booking.ref, error: emailResult?.error || 'Reminder delivery failed' });
        continue;
      }
      if (emailResult.logged === false) {
        errors.push({ ref: booking.ref, error: emailResult.logError || 'Reminder delivered but notification log failed' });
      }

      // Mark only after Resend accepted the message, or a prior confirmed send
      // caused deduplication after an earlier flag-write failure.
      let reminderFlagQuery = sb
        .from('bookings')
        .update({ reminder_sent: true })
        .eq('id', booking.id)
        .eq('status', booking.status)
        .eq('date', booking.date)
        .eq('reminder_sent', false);
      reminderFlagQuery = booking.time == null
        ? reminderFlagQuery.is('time', null)
        : reminderFlagQuery.eq('time', booking.time);
      const { error: flagErr, data: flaggedRows } = await reminderFlagQuery.select('id');
      if (flagErr) {
        errors.push({ ref: booking.ref, error: 'Reminder delivered but sent flag failed: ' + flagErr.message });
        continue;
      }
      if (!flaggedRows?.length) {
        errors.push({
          ref: booking.ref,
          error: 'Reminder was delivered for the prior appointment state; the booking changed before its reminder flag was saved.',
        });
        continue;
      }

      if (emailResult.suppressed) reconciled++;
      else sent++;
    } catch (e) {
      console.error(`Reminder error for booking ${booking.ref}:`, e);
      errors.push({ ref: booking.ref, error: e?.message || String(e) });
    }
  }

  const { data: easerBookings, error: easerBookingsError } = await sb
    .from('bookings')
    .select('id, ref, service, date, time, status, assembler_id, assembler_name, assembler_accepted_at')
    .eq('status', 'confirmed')
    .not('assembler_id', 'is', null)
    .not('assembler_accepted_at', 'is', null)
    .gte('date', todayStr)
    .lte('date', futureStr);
  if (easerBookingsError) {
    errors.push({ ref: null, error: 'Easer reminder query failed: ' + easerBookingsError.message });
  } else {
    for (const booking of easerBookings || []) {
      const bookingDatetimeMs = appointmentTimestampMs(booking.date, booking.time || '9:00 AM');
      if (bookingDatetimeMs == null) continue;
      const msUntil = bookingDatetimeMs - now.getTime();
      if (msUntil < 0 || msUntil > 25 * 60 * 60 * 1000) continue;
      try {
        await sendEaserReminder({ sb, booking });
      } catch (e) {
        errors.push({ ref: booking.ref, error: e?.message || String(e) });
      }
    }
  }

  // ── Stripe authorization expiry warning (day 5 of 7-day hold) ──────────────
  // Find confirmed bookings with payment authorized 5-6 days ago — approaching expiry
  const day5ago = new Date(now.getTime() - 5 * 86400000).toISOString();
  const day6ago = new Date(now.getTime() - 6 * 86400000).toISOString();

  const { data: expiringAuths } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, date, amount_charged, total_price')
    .eq('status', 'confirmed')
    .eq('payment_status', 'authorized')
    .gte('payment_authorized_at', day6ago)
    .lte('payment_authorized_at', day5ago)
    .limit(20);

  if (expiringAuths && expiringAuths.length > 0) {
    const rows = expiringAuths.map(b =>
      `<tr><td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${esc(b.ref)}</td>` +
      `<td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${esc(b.service)}</td>` +
      `<td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${esc(b.date || '—')}</td>` +
      `<td style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:13px">${esc(b.customer_name)}</td></tr>`
    ).join('');

    try {
      const warningResult = await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase System <booking@assembleatease.com>',
        subject: `Action Required: ${expiringAuths.length} card authorization(s) expiring within 48 hours`,
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #fcd34d"><tr><td style="padding:24px">
    <p style="margin:0 0 8px;font-size:18px;font-weight:700;color:#92400e">Card Authorizations Expiring Soon</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">The following ${expiringAuths.length} booking(s) have card authorizations that will expire within ~48 hours (Stripe holds last 7 days). You must complete or cancel these jobs before the authorization expires, or the payment cannot be captured.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:6px;overflow:hidden">
      <tr style="background:#fafafa"><th style="padding:8px;text-align:left;font-size:12px;color:#71717a">Ref</th><th style="padding:8px;text-align:left;font-size:12px;color:#71717a">Service</th><th style="padding:8px;text-align:left;font-size:12px;color:#71717a">Date</th><th style="padding:8px;text-align:left;font-size:12px;color:#71717a">Customer</th></tr>
      ${rows}
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#71717a">Log in to the <a href="https://www.assembleatease.com/owner" style="color:#00BFFF">owner dashboard</a> to take action.</p>
  </td></tr></table>
</div></body></html>`,
        meta: {
          notificationType: 'cron_alert',
          recipientType: 'owner',
          disableDedupe: true,
        },
      });
      if (!warningResult?.ok) errors.push({ ref: null, error: warningResult?.error || 'Authorization warning delivery failed' });
    } catch (e) { console.error('Auth expiry warning email error:', e); }
  }

  await logCron('reminders', { status: errors.length ? 'warning' : 'ok', records: sent + reconciled, error: errors.length ? JSON.stringify(errors).slice(0, 1000) : null, duration: Date.now() - t });
  return res.status(200).json({ ok: true, sent, reconciled, expiringAuthsWarned: expiringAuths?.length || 0, errors: errors.length ? errors : undefined });
}

async function sendEaserReminder({ sb, booking }) {
  if (!booking.assembler_id || !booking.assembler_accepted_at) return;

  const { data: prior, error: priorError } = await sb
    .from('notification_log')
    .select('id, channel')
    .eq('booking_id', booking.id)
    .eq('recipient_user_id', booking.assembler_id)
    .eq('notification_type', 'easer_reminder')
    .in('status', ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'])
    .limit(1);
  if (priorError) throw priorError;
  const emailAlreadySent = prior?.some(row => row.channel === 'email');
  const smsAlreadySent = prior?.some(row => row.channel === 'sms');

  const { data: easer, error: easerError } = await sb
    .from('profiles')
    .select('id, full_name, email, phone, sms_consent_at, sms_opted_out_at')
    .eq('id', booking.assembler_id)
    .eq('role', 'assembler')
    .maybeSingle();
  if (easerError) throw easerError;
  if (!easer) return;

  const firstName = (easer.full_name || 'there').split(' ')[0];
  const appointmentLabel = `${formatAppointmentDateShort(booking.date)}${booking.time ? ` at ${formatSlotShort(booking.time)}` : ''}`;
  const subject = `Reminder: Your AssembleAtEase job is tomorrow — ${booking.ref}`;
  const emailResult = emailAlreadySent
    ? { ok: true, skipped: 'already_sent' }
    : easer.email
    ? await sendEmail({
      to: easer.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject,
      html: buildEaserReminderEmail({ firstName, booking }),
      replyTo: 'service@assembleatease.com',
      meta: {
        bookingId: booking.id,
        notificationType: 'easer_reminder',
        recipientType: 'easer',
        recipientUserId: easer.id,
        disableDedupe: true,
      },
    })
    : { ok: false, skipped: 'missing_easer_email' };

  const smsResult = smsAlreadySent
    ? { ok: true, skipped: 'already_sent' }
    : await sendSms({
      recipient: easer,
      body: `Reminder: your AssembleAtEase job is ${appointmentLabel}. Open your dashboard for details. Ref ${booking.ref}`,
      meta: {
        bookingId: booking.id,
        notificationType: 'easer_reminder',
        recipientType: 'easer',
        recipientUserId: easer.id,
      },
    });

  if (!emailResult?.ok && !smsResult?.ok && !smsResult?.skipped) {
    throw new Error(emailResult?.error || smsResult?.error || 'Easer reminder delivery failed');
  }
}

function buildEaserReminderEmail({ firstName, booking }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#71717a">Job reminder</p>
    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#1a1a1a">Your job is tomorrow, ${esc(firstName)}</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">This is a reminder for your accepted AssembleAtEase job. Open your dashboard before you leave so you have the latest job details.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-bottom:20px">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:120px">Booking ref</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-family:monospace">${esc(booking.ref)}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Service</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(booking.service || 'Service')}</td></tr>
      <tr><td style="padding:10px 0;color:#71717a">When</td><td style="padding:10px 0;font-weight:700">${esc(formatAppointmentDate(booking.date))}${booking.time ? ` at ${esc(formatSlotShort(booking.time))}` : ''}</td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#52525b;line-height:1.6">Please review the job in your dashboard and tap Arrived when you are on site.</p>
  </td></tr></table>
</div></body></html>`;
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
        <tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Date</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(formatAppointmentDate(booking.date))}</td></tr>
        ${booking.time ? `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Time</td><td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700">${esc(booking.time)}</td></tr>` : ''}
        ${booking.address ? `<tr><td style="padding:10px 0;color:#71717a">Address</td><td style="padding:10px 0">${esc(formatAddress(booking.address))}</td></tr>` : ''}
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
      AssembleAtEase &bull; Serving customers across Texas &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
    </td></tr>
  </table>

</div>
</body></html>`;
}
