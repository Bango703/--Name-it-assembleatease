import { getSupabase } from '../_supabase.js';
import { sendPushToUser } from '../_push.js';
import { sendSms } from '../_sms.js';
import { logActivity } from '../booking/_activity.js';
import { appointmentTimestampMs } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/easer-arrival-nudge — runs every 15 minutes.
 *
 * WHY THIS EXISTS
 * Easers arrive at jobs and never tap "Arrived", so the owner cannot tell
 * whether anyone showed up. Nothing in the platform ever asked them to. The
 * customer gets appointment reminders; the owner gets a no-show alert sixty
 * minutes after the appointment should have started. The Easer — the only
 * person who can actually update the status — received an assignment email and
 * then nothing at all.
 *
 * So this asks. Once at the appointment time, once again thirty minutes later,
 * and then it stops and leaves the existing no-show-check to alert the owner.
 *
 * WHY IT STOPS AT TWO
 * A third nudge does not produce a tap; it produces an Easer who mutes
 * notifications, and then no nudge works ever again. Two asks and hand it to a
 * human is the honest ceiling.
 *
 * This NEVER changes booking state. It cannot mark a job arrived, started, or
 * complete — only the Easer can say they are there, and a cron guessing on their
 * behalf would be exactly the false assertion Article 16 forbids.
 */

const NUDGE_AT_MINUTES = 0;        // first ask: appointment start
const SECOND_NUDGE_MINUTES = 30;   // second ask: half an hour later
const MAX_NUDGES = 2;
const LOOKBACK_HOURS = 6;          // ignore anything older; the owner owns it by then

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const now = Date.now();
  let nudged = 0;
  const skipped = [];

  try {
    // Accepted jobs that have not reached the site yet. A job the Easer has not
    // accepted is a dispatch problem, not a status problem — offers own that.
    const { data: candidates, error } = await sb
      .from('bookings')
      .select('id, ref, service, date, time, address, assembler_id, assembler_name, status, checked_in_at, en_route_at, assembler_accepted_at, arrival_nudge_sent_at, arrival_nudge_count')
      .eq('status', 'confirmed')
      .not('assembler_id', 'is', null)
      .not('assembler_accepted_at', 'is', null)
      .is('checked_in_at', null)
      .gte('date', new Date(now - LOOKBACK_HOURS * 3600000).toISOString().slice(0, 10));

    if (error) throw error;

    for (const booking of candidates || []) {
      const apptMs = appointmentTimestampMs(booking.date, booking.time);
      if (!apptMs) { skipped.push({ ref: booking.ref, why: 'no_appointment_time' }); continue; }

      const minutesSince = (now - apptMs) / 60000;
      if (minutesSince < NUDGE_AT_MINUTES) continue;                 // not due yet
      if (minutesSince > LOOKBACK_HOURS * 60) continue;              // too old to chase

      const sentCount = Number(booking.arrival_nudge_count || 0);
      if (sentCount >= MAX_NUDGES) continue;
      if (sentCount === 1 && minutesSince < SECOND_NUDGE_MINUTES) continue;

      // Guard against a double-send if two cron invocations overlap: only the
      // request that still sees the count it read may advance it.
      const { data: claimed, error: claimErr } = await sb
        .from('bookings')
        .update({
          arrival_nudge_count: sentCount + 1,
          arrival_nudge_sent_at: new Date().toISOString(),
        })
        .eq('id', booking.id)
        .eq('arrival_nudge_count', sentCount)
        .is('checked_in_at', null)
        .select('id');
      if (claimErr || !claimed?.length) { skipped.push({ ref: booking.ref, why: 'claim_lost' }); continue; }

      const second = sentCount === 1;
      const body = second
        ? `Still on ${booking.service || 'the job'}? Tap Arrived so the customer and the office know you're there.`
        : `You're due at ${booking.service || 'a job'} now. Tap Arrived when you get there.`;

      const push = await sendPushToUser(booking.assembler_id, {
        title: second ? 'Did you make it?' : 'Time to check in',
        body,
        url: 'https://www.assembleatease.com/assembler/my-assignments',
        jobId: booking.id,
        urgent: true,
      }, {
        bookingId: booking.id,
        notificationType: 'arrival_nudge',
        recipientType: 'easer',
      }).catch(err => ({ ok: false, error: err?.message || String(err) }));

      // SMS is the fallback for a pro whose push is off — the exact person this
      // whole cron exists for. Refuses itself without recorded consent.
      let sms = { ok: false, skipped: 'not_attempted' };
      if (!push?.ok) {
        const { data: easer } = await sb
          .from('profiles')
          .select('id, phone, sms_consent_at, sms_opted_out_at')
          .eq('id', booking.assembler_id)
          .maybeSingle();
        if (easer) {
          sms = await sendSms({
            recipient: easer,
            body: `AssembleAtEase: tap Arrived on ${booking.ref} so the office knows you're on site.`,
            meta: { bookingId: booking.id, notificationType: 'arrival_nudge', recipientType: 'easer', recipientUserId: easer.id },
          });
        }
      }

      nudged += 1;
      await logActivity(sb, {
        bookingId: booking.id,
        eventType: 'arrival_nudge_sent',
        actorType: 'system',
        actorName: 'arrival-nudge',
        description: `Reminded ${booking.assembler_name || 'the Easer'} to check in (${sentCount + 1} of ${MAX_NUDGES})`,
        metadata: {
          minutesPastAppointment: Math.round(minutesSince),
          push: push?.ok === true,
          sms: sms?.ok === true,
          smsSkipped: sms?.skipped || null,
        },
      }).catch(() => {});
    }

    await logCron('easer-arrival-nudge', { status: 'ok', records: nudged, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: true, nudged, skipped });
  } catch (err) {
    console.error('[easer-arrival-nudge] failed:', err?.message || err);
    await logCron('easer-arrival-nudge', { status: 'error', records: nudged, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Arrival nudge run failed' });
  }
}
