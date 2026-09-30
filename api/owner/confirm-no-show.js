import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, esc } from '../_email.js';
import { BOOKING_STATUS, EASER_RELIABILITY_POLICY } from '../_source-of-truth.js';
import { appointmentTimestampMs, formatAppointmentDate } from '../booking/_appt-date.js';
import { loadEaserStrikes, recordEaserCancellation, pauseEaserIfOverLimit } from '../_easer-reliability.js';

/**
 * POST /api/owner/confirm-no-show { bookingId } — owner only.
 *
 * The no-show check only flags a POSSIBLE no-show (the Easer never tapped
 * Arrived an hour past the start). A late Easer is not always a no-show, so
 * that flag never counts on its own. The owner confirms here, after checking,
 * and the confirmed no-show counts EASER_RELIABILITY_POLICY.noShowStrikes.
 * It does not move the job; the owner reassigns it with the existing tools.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The booking could not be read.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.assembler_id || !booking.assembler_accepted_at) {
    return res.status(409).json({ error: 'No Easer had accepted this job, so there is no no-show to record.' });
  }
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    return res.status(409).json({ error: `The job is ${String(booking.status).replace('_', ' ')}, so the Easer is not a no-show.` });
  }
  let startMs = null;
  try { startMs = appointmentTimestampMs(booking.date, booking.time); } catch (_) { startMs = null; }
  if (startMs == null) return res.status(409).json({ error: 'The appointment time could not be read, so a no-show cannot be confirmed.' });
  const nowMs = Date.now();
  if (startMs > nowMs) return res.status(409).json({ error: 'The appointment has not started yet.' });

  const easerId = booking.assembler_id;
  const easerName = booking.assembler_name || 'The Easer';

  // One no-show per booking and Easer.
  const { data: existing, error: existingError } = await sb.from('activity_logs')
    .select('id').eq('booking_id', booking.id).eq('event_type', 'easer_cancelled')
    .contains('metadata', { easerId, kind: 'no_show' }).limit(1);
  if (existingError) return res.status(503).json({ error: 'Reliability history could not be read.' });
  if (existing?.length) return res.status(200).json({ ok: true, alreadyRecorded: true });

  const classification = {
    kind: 'no_show',
    strikes: EASER_RELIABILITY_POLICY.noShowStrikes,
    hoursUntilStart: (startMs - nowMs) / 3600000,
    minutesSinceAccept: (nowMs - new Date(booking.assembler_accepted_at).getTime()) / 60000,
  };
  const record = await recordEaserCancellation(sb, { booking, easerId, easerName, classification, reason: 'No-show confirmed by owner' });
  if (!record.ok) return res.status(503).json({ error: 'The no-show could not be saved. Nothing was changed.' });

  let strikes = classification.strikes;
  try { strikes = (await loadEaserStrikes(sb, [easerId], { nowMs })).get(easerId)?.strikes ?? strikes; } catch (_) { /* counted above */ }
  const pause = await pauseEaserIfOverLimit(sb, { easerId, easerName, strikes, bookingId: booking.id });

  // Tell the Easer what was recorded (Rule 10: they always know their standing).
  const { data: easer } = await sb.from('profiles').select('email').eq('id', easerId).maybeSingle();
  let easerNotified = false;
  if (easer?.email) {
    const sent = await sendEmail({
      to: easer.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `No-show recorded — ${booking.ref}`,
      html: `<p>A no-show was recorded for job <strong>${esc(booking.ref)}</strong> on ${esc(formatAppointmentDate(booking.date))} at ${esc(booking.time || '')}.</p>
<p>This counts as ${classification.strikes} reliability strikes. You now have ${strikes} in the last ${EASER_RELIABILITY_POLICY.windowDays} days.${pause.paused ? ' New jobs are paused until AssembleAtEase reviews your account.' : ` At ${EASER_RELIABILITY_POLICY.pauseAtStrikes}, new jobs pause.`}</p>
<p>If you were there, send a message from the job in the app with the details.</p>`,
      meta: { bookingId: booking.id, notificationType: 'easer_no_show_recorded', recipientType: 'easer', recipientUserId: easerId },
    }).catch(() => null);
    easerNotified = sent?.ok === true;
  }

  return res.status(200).json({
    ok: true,
    strikesAdded: classification.strikes,
    strikes,
    paused: pause.paused === true,
    easerNotified,
    message: `No-show recorded: ${classification.strikes} strikes. ${easerName} now has ${strikes} in the last ${EASER_RELIABILITY_POLICY.windowDays} days.${pause.paused ? ' New jobs are paused for this Easer.' : ''} Use Reassign to send someone else.`,
  });
}
