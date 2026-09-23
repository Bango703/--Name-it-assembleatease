import { getSupabase } from '../_supabase.js';
import { sendPushToUser } from '../_push.js';
import { sendSms } from '../_sms.js';
import { logActivity } from '../booking/_activity.js';
import { notificationAppointmentTimestampMs, appointmentTimeZone } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { acquireNotificationLease, releaseNotificationLease, notificationDeliveryKey } from '../_notification-policy.js';

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
const BOOKING_SELECT = 'id, ref, service, date, time, address, service_zip, service_city, assembler_id, assembler_name, status, checked_in_at, en_route_at, assembler_accepted_at, assigned_at, rescheduled_at, arrival_nudge_sent_at, arrival_nudge_count, return_visit_required';

export function buildArrivalNudgeSms(ref) {
  return `AssembleAtEase ${ref}: tap Arrived only when on site. If delayed, contact us. assembleatease.com/assembler/my-assignments`;
}

export function arrivalNudgeDue(booking, now) {
  // A return visit has its own schedule; original-visit check-in state cannot
  // establish whether that separately scheduled visit is late.
  if (booking.return_visit_required === true) return false;
  if (![BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE].includes(booking.status)
      || !booking.assembler_id || !booking.assembler_accepted_at || booking.checked_in_at) return false;
  const apptMs = notificationAppointmentTimestampMs(booking);
  if (apptMs == null) return false;
  const minutesSince = (now - apptMs) / 60000;
  if (minutesSince < NUDGE_AT_MINUTES || minutesSince > LOOKBACK_HOURS * 60) return false;
  const sentCount = Number(booking.arrival_nudge_count || 0);
  if (!Number.isInteger(sentCount) || sentCount < 0 || sentCount >= MAX_NUDGES) return false;
  if (sentCount === 0) return true;
  const lastSentMs = Date.parse(booking.arrival_nudge_sent_at);
  // Missing/invalid history is not permission to send a second immediate nudge.
  return Number.isFinite(lastSentMs) && now - lastSentMs >= SECOND_NUDGE_MINUTES * 60000;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  const now = Date.now();
  let nudged = 0;
  let failed = 0;
  const skipped = [];

  try {
    // Accepted jobs that have not reached the site yet. A job the Easer has not
    // accepted is a dispatch problem, not a status problem — offers own that.
    const { data: candidates, error } = await sb
      .from('bookings')
      .select(BOOKING_SELECT)
      .in('status', [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE])
      .not('assembler_id', 'is', null)
      .not('assembler_accepted_at', 'is', null)
      .is('checked_in_at', null)
      .gte('date', new Date(now - LOOKBACK_HOURS * 3600000).toISOString().slice(0, 10));

    if (error) throw error;

    for (const candidate of candidates || []) {
      if (!arrivalNudgeDue(candidate, now)) continue;
      const leaseKey = `arrival-nudge:${candidate.id}`;
      const lease = await acquireNotificationLease(sb, leaseKey);
      if (!lease?.ok) {
        if (lease?.error) failed++;
        skipped.push({ ref: candidate.ref, why: lease?.reason || 'claim_lost' });
        continue;
      }
      try {
        // Reload AFTER claiming: overlapping runs and assignment/status changes
        // must not reuse the earlier scan's count or recipient.
        const { data: booking, error: reloadError } = await sb.from('bookings')
          .select(BOOKING_SELECT).eq('id', candidate.id).maybeSingle();
        if (reloadError) throw reloadError;
        if (!booking || booking.assembler_id !== candidate.assembler_id
            || booking.assembler_accepted_at !== candidate.assembler_accepted_at
            || booking.date !== candidate.date || booking.time !== candidate.time
            || !arrivalNudgeDue(booking, Date.now())) continue;
        const apptMs = notificationAppointmentTimestampMs(booking);
        const minutesSince = (Date.now() - apptMs) / 60000;
        const sentCount = Number(booking.arrival_nudge_count || 0);
        const second = sentCount === 1;
        const body = second
          ? `Please update ${booking.ref}. Tap Arrived only once you are on site, or contact us if you are delayed.`
          : `Your arrival window for ${booking.ref} has started. Tap Arrived once you are on site.`;
        const notificationKey = ['arrival-nudge', booking.id, booking.date, booking.time, booking.assembler_id, booking.assembler_accepted_at, sentCount + 1].join(':');
        const title = second ? 'Arrival check-in reminder' : 'Time to check in';

        const { data: priorSms, error: smsHistoryError } = await sb.from('notification_log')
          .select('status, sent_at, provider_accepted_at')
          .eq('notification_key', notificationDeliveryKey('sms', `user:${booking.assembler_id}`, notificationKey))
          .maybeSingle();
        if (smsHistoryError) throw smsHistoryError;
        if (['queued', 'deferred', 'uncertain'].includes(priorSms?.status)) {
          // An SMS may already be on its way. A push fallback cannot prove that
          // uncertain delivery failed and must not create a second interruption.
          skipped.push({ ref: booking.ref, why: 'sms_delivery_pending_or_unknown' });
          continue;
        }
        const smsRecovered = ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'].includes(priorSms?.status);

        // Recover a successful push whose counter write failed. Several devices
        // can produce several log rows; they remain one nudge for this event.
        const since = new Date(Math.max(apptMs, Date.parse(booking.assembler_accepted_at) || 0, Date.parse(booking.rescheduled_at) || 0)).toISOString();
        const { data: priorPush, error: priorError } = await sb.from('notification_log')
          .select('sent_at').eq('booking_id', booking.id).eq('channel', 'push')
          .eq('recipient_user_id', booking.assembler_id).eq('notification_type', 'arrival_nudge')
          .eq('subject', title).eq('status', 'sent').gte('sent_at', since)
          .order('sent_at', { ascending: true }).limit(1);
        if (priorError) throw priorError;

        const push = smsRecovered ? { ok: false, skipped: 'sms_already_sent' } : priorPush?.length ? { ok: true, recovered: true, sentAt: priorPush[0].sent_at } : await sendPushToUser(booking.assembler_id, {
          title,
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
        let sms = smsRecovered ? { ok: true, suppressed: true, sentAt: priorSms.provider_accepted_at || priorSms.sent_at } : { ok: false, skipped: 'not_attempted' };
        if (!push?.ok && !smsRecovered) {
          const { data: easer } = await sb
            .from('profiles')
            .select('id, phone, sms_consent_at, sms_opted_out_at')
            .eq('id', booking.assembler_id)
            .maybeSingle();
          if (easer) {
            sms = await sendSms({
              recipient: easer,
              body: buildArrivalNudgeSms(booking.ref),
              meta: { bookingId: booking.id, notificationType: 'arrival_nudge', recipientType: 'easer', recipientUserId: easer.id, notificationKey, routine: false, timeZone: appointmentTimeZone(booking), expiresAt: new Date(apptMs + LOOKBACK_HOURS * 3600000).toISOString() },
            });
          }
        }

        const success = push?.ok === true || sms?.ok === true;
        if (!success) {
          if (sms?.deferred) { skipped.push({ ref: booking.ref, why: sms.reason || 'send_deferred' }); continue; }
          failed++;
          await logActivity(sb, {
            bookingId: booking.id, eventType: sms?.uncertain ? 'arrival_nudge_delivery_unknown' : 'arrival_nudge_failed', actorType: 'system', actorName: 'arrival-nudge',
            description: sms?.uncertain
              ? 'SMS delivery is unverified. Check the provider status before retrying; no successful nudge was recorded.'
              : 'Arrival reminder was not accepted for delivery. Review the push and SMS outcomes; no successful nudge was recorded.',
            metadata: { notificationKey, pushError: push?.error || push?.reason || null, smsError: sms?.error || sms?.reason || sms?.skipped || null },
          });
          continue;
        }

        const sentAt = push?.sentAt || sms?.sentAt || new Date().toISOString();
        const { data: marked, error: markError } = await sb.from('bookings').update({
          arrival_nudge_count: sentCount + 1,
          arrival_nudge_sent_at: sentAt,
        }).eq('id', booking.id).eq('arrival_nudge_count', sentCount)
          .in('status', [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE])
          .eq('assembler_id', booking.assembler_id).eq('assembler_accepted_at', booking.assembler_accepted_at)
          .eq('date', booking.date).eq('time', booking.time).is('checked_in_at', null).select('id');
        if (markError) throw markError;
        if (!push?.recovered && !sms?.suppressed) nudged += 1;
        await logActivity(sb, {
          bookingId: booking.id,
          eventType: 'arrival_nudge_sent',
          actorType: 'system',
          actorName: 'arrival-nudge',
          description: `Arrival reminder accepted for delivery to ${booking.assembler_name || 'the Easer'} (${sentCount + 1} of ${MAX_NUDGES})`,
          metadata: {
            minutesPastAppointment: Math.round(minutesSince),
            push: push?.ok === true,
            sms: sms?.ok === true,
            smsSkipped: sms?.skipped || null,
            notificationKey,
            bookingStampUpdated: Boolean(marked?.length),
          },
        }).catch(() => {});
      } catch (err) {
        failed++;
        console.error('[easer-arrival-nudge] booking failed:', candidate.ref, err?.message || err);
        skipped.push({ ref: candidate.ref, why: 'delivery_or_recording_failed' });
      } finally {
        await releaseNotificationLease(sb, leaseKey, lease.token);
      }
    }

    await logCron('easer-arrival-nudge', { status: failed ? 'error' : 'ok', records: nudged, errorText: failed ? `${failed} arrival reminder(s) failed; retry required` : null, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: failed === 0, nudged, failed, skipped });
  } catch (err) {
    console.error('[easer-arrival-nudge] failed:', err?.message || err);
    await logCron('easer-arrival-nudge', { status: 'error', records: nudged, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Arrival nudge run failed' });
  }
}
