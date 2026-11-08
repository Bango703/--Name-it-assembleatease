import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, esc } from '../_email.js';
import { EASER_RELIABILITY_POLICY } from '../_source-of-truth.js';
import { appointmentTimestampMs, formatAppointmentDate } from '../booking/_appt-date.js';
import { sendPushToUser } from '../_push.js';
import {
  loadEaserStrikeSummary, excuseEaserCancellation,
  CONFIRMED_ISSUES, recordConfirmedIssue, loadEaserStrikes, pauseEaserIfOverLimit,
} from '../_easer-reliability.js';

/**
 * Owner view of an Easer's reliability strikes, and the owner's actions.
 *   GET  /api/owner/easer-reliability?easerId=...      → strikes + each event
 *   POST /api/owner/easer-reliability { logId, note }   → excuse one strike
 *   POST /api/owner/easer-reliability
 *        { action: 'confirm_issue', bookingId, kind, note } → record a confirmed
 *        late arrival, workmanship problem or property damage (CONFIRMED_ISSUES)
 * Excusing removes the strikes; it does not reactivate a paused Easer. That
 * stays the owner's explicit decision on the Easers page.
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'GET') {
    const easerId = String(req.query?.easerId || '').trim();
    if (!easerId) return res.status(400).json({ error: 'easerId is required' });
    try {
      const summary = await loadEaserStrikeSummary(sb, easerId);
      return res.status(200).json(summary);
    } catch (error) {
      console.error('[owner-easer-reliability] read failed:', error?.message || error);
      return res.status(503).json({ error: 'Reliability history could not be read.' });
    }
  }

  if (req.method === 'POST') {
    if (req.body?.action === 'confirm_issue') return confirmIssue(sb, req, res);
    const { logId, note } = req.body || {};
    if (!logId) return res.status(400).json({ error: 'logId is required' });
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : null;
    const result = await excuseEaserCancellation(sb, { logId, excusedBy: 'Owner', note: cleanNote || null });
    if (!result.ok) return res.status(result.status || 500).json({ error: result.error });
    const summary = await loadEaserStrikeSummary(sb, result.easerId).catch(() => null);
    return res.status(200).json({ ok: true, alreadyExcused: result.alreadyExcused === true, summary });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// The owner checked and confirms a problem on a job. Same shape as a confirmed
// no-show (api/owner/confirm-no-show.js): strikes counted, pause at the limit
// (property damage pauses at once), the Easer told what was recorded.
async function confirmIssue(sb, req, res) {
  const bookingId = String(req.body?.bookingId || '').trim();
  const kind = String(req.body?.kind || '').trim();
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
  const issue = CONFIRMED_ISSUES[kind];
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!issue) return res.status(400).json({ error: 'Choose late arrival, workmanship or property damage.' });

  const { data: booking, error } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
  if (error) return res.status(503).json({ error: 'The booking could not be read.' });
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (!booking.assembler_id || !booking.assembler_accepted_at) {
    return res.status(409).json({ error: 'No Easer accepted this job, so there is no one to record this against.' });
  }
  if (!issue.statuses.includes(booking.status)) {
    return res.status(409).json({ error: `This job is ${String(booking.status).replace('_', ' ')}, so a ${issue.label.toLowerCase()} cannot be recorded on it.` });
  }
  if (kind === 'late_arrival') {
    const startMs = appointmentTimestampMs(booking.date, booking.time);
    if (startMs == null || startMs > Date.now()) return res.status(409).json({ error: 'The appointment has not started yet.' });
  }

  const easerId = booking.assembler_id;
  const easerName = booking.assembler_name || 'The Easer';
  const record = await recordConfirmedIssue(sb, { booking, easerId, easerName, kind, note });
  if (!record.ok) return res.status(record.status || 503).json({ error: record.error });
  if (record.alreadyRecorded) return res.status(200).json({ ok: true, alreadyRecorded: true, message: 'This was already recorded on this job.' });

  let strikes = issue.strikes;
  try { strikes = (await loadEaserStrikes(sb, [easerId])).get(easerId)?.strikes ?? strikes; } catch (_) { /* counted above */ }
  const pause = await pauseEaserIfOverLimit(sb, {
    easerId, easerName, strikes, bookingId: booking.id,
    force: issue.pausesNow,
    why: issue.pausesNow ? `${issue.label.toLowerCase()} on ${booking.ref}` : null,
  });

  const { data: easer } = await sb.from('profiles').select('email').eq('id', easerId).maybeSingle();
  const title = issue.label.replace(/ \(.*\)$/, '');
  const standing = `This counts as ${issue.strikes} reliability strike${issue.strikes === 1 ? '' : 's'}. You now have ${strikes} in the last ${EASER_RELIABILITY_POLICY.windowDays} days.`
    + (pause.paused ? ' New jobs are paused until AssembleAtEase reviews your account.' : ` At ${EASER_RELIABILITY_POLICY.pauseAtStrikes}, new jobs pause.`);
  const meta = { bookingId: booking.id, notificationType: 'easer_strike_recorded', recipientType: 'easer', recipientUserId: easerId };
  let easerNotified = false;
  if (easer?.email) {
    const sent = await sendEmail({
      to: easer.email,
      subject: `${title} recorded — ${booking.ref}`,
      html: `<p>A ${esc(issue.label.toLowerCase())} was recorded for job <strong>${esc(booking.ref)}</strong> on ${esc(formatAppointmentDate(booking.date))}.</p>
${note ? `<p>Note from AssembleAtEase: ${esc(note)}</p>` : ''}
<p>${esc(standing)}</p>
<p>If you think this is wrong, send a message from the job in the app with the details.</p>`,
      meta,
    }).catch(() => null);
    easerNotified = sent?.ok === true;
  }
  await sendPushToUser(easerId, {
    title: `${title} recorded`,
    body: standing,
    url: '/assembler/my-assignments',
    jobId: booking.id,
  }, meta).catch(() => null);

  return res.status(200).json({
    ok: true,
    strikesAdded: issue.strikes,
    strikes,
    paused: pause.paused === true,
    easerNotified,
    message: `${issue.label} recorded: ${issue.strikes} strike${issue.strikes === 1 ? '' : 's'}. ${easerName} now has ${strikes} in the last ${EASER_RELIABILITY_POLICY.windowDays} days.${pause.paused ? ' New jobs are paused for this Easer.' : ''}`,
  });
}
