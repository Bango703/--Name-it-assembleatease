import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { sendEmail, buildStatusEmail, ownerEmail, esc } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { appointmentTimestampMs } from './_appt-date.js';

/**
 * POST /api/booking/reschedule
 * Guest self-service reschedule — no login (email + ref, like track/cancel).
 * Body: { email, ref, date, time }
 *
 * Policy (owner-set):
 *  - Reschedulable only while pending/confirmed (not once en route or later).
 *  - Free to reschedule, up to MAX_RESCHEDULES times (counted via activity_logs).
 *  - Rescheduling FORFEITS free cancellation: once rescheduled, any later
 *    cancellation incurs a fee regardless of the 24h window (10%, or 15% if a pro is en route). guest-cancel.js
 *    enforces this by detecting a prior 'rescheduled' activity event.
 *  - Assigned Pro is kept; owner + Pro are notified of the new date.
 *  - No Stripe action: the existing manual-capture auth carries; the reauth cron
 *    re-authorizes based on the (new) appointment date.
 */
const MAX_RESCHEDULES = 2;
const TIME_SLOTS = [
  '7:00 AM – 9:00 AM', '9:00 AM – 11:00 AM', '11:00 AM – 1:00 PM',
  '1:00 PM – 3:00 PM', '3:00 PM – 5:00 PM', '5:00 PM – 7:00 PM',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!await rateLimit(ip, 'booking')) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref, date, time } = req.body || {};
  if (!email || !ref || !date || !time) {
    return res.status(400).json({ error: 'Email, booking reference, new date, and new time are required.' });
  }

  // ── Validate new date is within the online booking window (today .. +6 days) ──
  const requestedDate = new Date(`${date}T00:00:00`);
  if (Number.isNaN(requestedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid appointment date.' });
  }
  const windowStart = new Date(); windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + 6 * 24 * 60 * 60 * 1000);
  if (requestedDate < windowStart || requestedDate > windowEnd) {
    return res.status(400).json({ error: 'New date must be within the next 6 days. For later dates, email service@assembleatease.com.' });
  }
  if (!TIME_SLOTS.includes(time)) {
    return res.status(400).json({ error: 'Please choose a valid time slot.' });
  }
  // New appointment must be in the future
  const newApptMs = appointmentTimestampMs(date, time);
  if (newApptMs != null && newApptMs < Date.now()) {
    return res.status(400).json({ error: 'That time has already passed. Please choose a later slot.' });
  }

  const sb = getSupabase();
  const { data: booking, error: fetchErr } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .ilike('customer_email', email.trim())
    .maybeSingle();

  if (fetchErr) {
    console.error('Reschedule lookup error:', fetchErr);
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking) {
    return res.status(404).json({ error: 'Booking not found. Check your reference and email.' });
  }

  // ── Only pending/confirmed bookings can be self-rescheduled ──
  const reschedulable = [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED];
  if (!reschedulable.includes(booking.status)) {
    const msg = ['en_route', 'arrived', 'in_progress'].includes(booking.status)
      ? 'Your pro is already on the way — please call us at (737) 290-6129 to make changes.'
      : 'This booking can no longer be rescheduled. Please contact us at (737) 290-6129.';
    return res.status(400).json({ error: msg });
  }

  if (date === booking.date && time === booking.time) {
    return res.status(400).json({ error: 'That is already your scheduled date and time.' });
  }

  // ── Enforce reschedule limit via activity_logs count ──
  let priorReschedules = 0;
  try {
    const { count } = await sb
      .from('activity_logs')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', booking.id)
      .eq('event_type', 'rescheduled');
    priorReschedules = count || 0;
  } catch (e) {
    console.warn('Reschedule count check failed (continuing):', e.message);
  }
  if (priorReschedules >= MAX_RESCHEDULES) {
    return res.status(409).json({
      error: `This booking has already been rescheduled ${MAX_RESCHEDULES} times. Please call us at (737) 290-6129 for further changes.`,
      code: 'RESCHEDULE_LIMIT_REACHED',
    });
  }

  const oldDate = booking.date, oldTime = booking.time;

  const { error: updateErr } = await sb.from('bookings').update({
    date,
    time,
    rescheduled_at: new Date().toISOString(),
  }).eq('id', booking.id);

  // rescheduled_at may not exist on older schemas — retry with date/time only.
  if (updateErr) {
    const { error: retryErr } = await sb.from('bookings').update({ date, time }).eq('id', booking.id);
    if (retryErr) {
      console.error('Reschedule update failed:', retryErr);
      return res.status(500).json({ error: 'Unable to reschedule. Please call us at (737) 290-6129.' });
    }
  }

  const remaining = MAX_RESCHEDULES - (priorReschedules + 1);

  // Timeline event — ALSO the marker guest-cancel.js uses to forfeit free cancellation.
  logActivity(sb, {
    bookingId: booking.id,
    eventType: 'rescheduled',
    actorType: 'guest',
    actorName: booking.customer_name || 'Guest customer',
    description: `Customer rescheduled from ${oldDate} ${oldTime} to ${date} ${time}. Reschedule ${priorReschedules + 1} of ${MAX_RESCHEDULES}.`,
    metadata: { oldDate, oldTime, newDate: date, newTime: time, rescheduleNumber: priorReschedules + 1 },
  });

  // ── Email customer: confirm + disclose cancellation lock ──
  try {
    await sendEmail({
      to: booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Appointment Rescheduled — ${booking.ref}`,
      replyTo: ownerEmail(),
      html: buildStatusEmail({
        customerName: booking.customer_name,
        ref: booking.ref,
        status: 'RESCHEDULED',
        statusColor: '#0369a1',
        statusBg: '#f0f9ff',
        headline: 'Your appointment has been rescheduled.',
        bodyHtml: `
          <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Your <strong>${esc(booking.service)}</strong> appointment is now set for <strong>${esc(date)}</strong> at <strong>${esc(time)}</strong>.</p>
          <p style="margin:0 0 16px;font-size:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:12px 16px;color:#92400e">
            Please note: because this booking has been rescheduled, cancelling it now incurs a cancellation fee even with 24+ hours notice (10% of the service subtotal, or 15% once a pro is on the way — never tax, never the full amount). ${remaining > 0 ? `You can reschedule ${remaining} more time if needed.` : 'This was your final self-service reschedule — contact us for any further changes.'}
          </p>
          <p style="margin:0;font-size:14px;color:#52525b">Need anything else? Reply to this email or call (737) 290-6129.</p>`,
      }),
    });
  } catch (e) { console.error('Reschedule customer email error:', e); }

  // ── Notify owner ──
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase System <booking@assembleatease.com>',
      subject: `Rescheduled — ${booking.ref} (${esc(booking.customer_name || '')})`,
      html: `<p>Customer rescheduled <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p>
<p><strong>Old:</strong> ${esc(oldDate)} at ${esc(oldTime)}<br/><strong>New:</strong> ${esc(date)} at ${esc(time)}</p>
${booking.assembler_name ? `<p><strong>${esc(booking.assembler_name)}</strong> is assigned — confirm they can make the new date, or reassign from the dashboard.</p>` : '<p>No pro assigned yet.</p>'}
<p>Reschedule ${priorReschedules + 1} of ${MAX_RESCHEDULES}.</p>`,
      replyTo: ownerEmail(),
    });
  } catch (e) { console.error('Reschedule owner email error:', e); }

  // ── Notify assigned Pro (if one accepted) ──
  if (booking.assembler_id && booking.assembler_accepted_at) {
    try {
      const { data: pro } = await sb.from('profiles').select('email, full_name').eq('id', booking.assembler_id).maybeSingle();
      if (pro?.email) {
        await sendEmail({
          to: pro.email,
          from: 'AssembleAtEase <booking@assembleatease.com>',
          subject: `Job date changed — ${booking.ref}`,
          replyTo: ownerEmail(),
          html: `<p>Hi ${esc((pro.full_name || '').split(' ')[0] || 'there')},</p>
<p>The customer rescheduled booking <strong>${esc(booking.ref)}</strong> (${esc(booking.service)}).</p>
<p><strong>New date/time:</strong> ${esc(date)} at ${esc(time)}<br/>(was ${esc(oldDate)} at ${esc(oldTime)})</p>
<p>If you can still make it, no action needed. If not, please contact the owner right away so it can be reassigned.</p>`,
          meta: { bookingId: booking.id, notificationType: 'reschedule_pro', recipientType: 'easer', recipientUserId: booking.assembler_id },
        });
      }
    } catch (e) { console.error('Reschedule pro email error:', e); }
  }

  return res.status(200).json({ success: true, date, time, reschedulesRemaining: Math.max(0, remaining) });
}
