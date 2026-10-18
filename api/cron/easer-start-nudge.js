import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, formatAddress } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { sendSms } from '../_sms.js';
import { logActivity } from '../booking/_activity.js';
import { appointmentTimeZone } from '../booking/_appt-date.js';
import { logCron } from './_cron-logger.js';
import { formatUsPhone } from '../_phone.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { acquireNotificationLease, releaseNotificationLease, notificationDeliveryKey } from '../_notification-policy.js';

/**
 * GET /api/cron/easer-start-nudge — runs every 5 minutes.
 *
 * An Easer who taps Arrived and starts working without tapping Start Job leaves
 * the job stuck at Arrived: the Complete button only appears once the job is in
 * progress, so the photo cannot count and the payment cannot be captured.
 *
 * Ten minutes after Arrived, the Easer gets ONE text (push if they have not
 * agreed to texts). Thirty minutes after Arrived, if the job has still not been
 * started, the owner gets ONE email and the Easer gets nothing more. Each send
 * is keyed to that arrival, so a later run, an overlapping run or a retry can
 * never send it twice. The 5-minute schedule is how often this looks, not how
 * often anyone is contacted.
 *
 * This NEVER changes booking state. Only the Easer can say work has started.
 */

export const START_NUDGE_AFTER_MINUTES = 10;   // one text to the Easer
export const OWNER_ALERT_AFTER_MINUTES = 30;   // one email to the owner
const LOOKBACK_HOURS = 6;                      // older arrivals belong to the owner already
const BOOKING_SELECT = 'id, ref, service, date, time, address, customer_name, customer_phone, assembler_id, assembler_name, status, checked_in_at, job_started_at, is_test_booking';
const SENT_STATUSES = ['provider_accepted', 'sent', 'delivered', 'delivery_delayed'];
const PENDING_STATUSES = ['queued', 'deferred', 'uncertain'];

export function buildStartNudgeSms(ref) {
  return `AssembleAtEase ${ref}: tap Start Job in the app before you begin work.`;
}

/** Minutes since the Easer tapped Arrived, or null when this job is not waiting on Start Job. */
export function minutesWaitingForStart(booking, now) {
  if (!booking || booking.status !== BOOKING_STATUS.ARRIVED || booking.is_test_booking === true
      || !booking.assembler_id || !booking.checked_in_at || booking.job_started_at) return null;
  const arrivedMs = Date.parse(booking.checked_in_at);
  if (!Number.isFinite(arrivedMs)) return null;
  const minutes = (now - arrivedMs) / 60000;
  if (minutes < START_NUDGE_AFTER_MINUTES || minutes > LOOKBACK_HOURS * 60) return null;
  return minutes;
}

export const startNudgeKey = booking => ['start-nudge', booking.id, booking.assembler_id, booking.checked_in_at].join(':');
export const startOverdueKey = booking => ['start-overdue', booking.id, booking.assembler_id, booking.checked_in_at].join(':');

async function nudgeEaser(sb, booking, skipped) {
  const notificationKey = startNudgeKey(booking);
  const { data: priorSms, error: smsHistoryError } = await sb.from('notification_log')
    .select('status, sent_at, provider_accepted_at')
    .eq('notification_key', notificationDeliveryKey('sms', `user:${booking.assembler_id}`, notificationKey))
    .maybeSingle();
  if (smsHistoryError) throw smsHistoryError;
  if (SENT_STATUSES.includes(priorSms?.status)) return 'already_sent';
  if (PENDING_STATUSES.includes(priorSms?.status)) { skipped.push({ ref: booking.ref, why: 'sms_delivery_pending_or_unknown' }); return 'pending'; }

  const title = 'Tap Start Job';
  const { data: priorPush, error: priorPushError } = await sb.from('notification_log')
    .select('sent_at').eq('booking_id', booking.id).eq('channel', 'push')
    .eq('recipient_user_id', booking.assembler_id).eq('notification_type', 'start_nudge')
    .eq('status', 'sent').gte('sent_at', booking.checked_in_at).limit(1);
  if (priorPushError) throw priorPushError;
  if (priorPush?.length) return 'already_sent';

  const { data: easer } = await sb.from('profiles')
    .select('id, phone, sms_consent_at, sms_opted_out_at')
    .eq('id', booking.assembler_id).maybeSingle();
  const sms = easer ? await sendSms({
    recipient: easer,
    body: buildStartNudgeSms(booking.ref),
    meta: { bookingId: booking.id, notificationType: 'start_nudge', recipientType: 'easer', recipientUserId: easer.id, notificationKey, routine: false, timeZone: appointmentTimeZone(booking), expiresAt: new Date(Date.parse(booking.checked_in_at) + LOOKBACK_HOURS * 3600000).toISOString() },
  }) : { ok: false, skipped: 'easer_not_found' };
  if (sms?.suppressed) return 'already_sent';
  if (sms?.deferred || sms?.uncertain) { skipped.push({ ref: booking.ref, why: sms.reason || sms.skipped || 'send_deferred' }); return 'pending'; }

  // No texts allowed (no consent, opted out, texting off): the app is the
  // only other way to reach them.
  let push = { ok: false, skipped: 'sms_sent' };
  if (!sms?.ok) {
    push = await sendPushToUser(booking.assembler_id, {
      title,
      body: `${booking.ref}: tap Start Job before you begin work.`,
      url: 'https://www.assembleatease.com/assembler/my-assignments',
      jobId: booking.id,
      urgent: true,
    }, { bookingId: booking.id, notificationType: 'start_nudge', recipientType: 'easer' })
      .catch(err => ({ ok: false, error: err?.message || String(err) }));
  }

  if (!sms?.ok && !push?.ok) {
    await logActivity(sb, {
      bookingId: booking.id, eventType: 'start_nudge_failed', actorType: 'system', actorName: 'start-nudge',
      description: 'Start Job reminder was not accepted for delivery by text or app notification.',
      metadata: { notificationKey, smsError: sms?.error || sms?.reason || sms?.skipped || null, pushError: push?.error || push?.reason || null },
    }).catch(() => {});
    return 'failed';
  }
  await logActivity(sb, {
    bookingId: booking.id, eventType: 'start_nudge_sent', actorType: 'system', actorName: 'start-nudge',
    description: `Start Job reminder sent to ${booking.assembler_name || 'the Easer'} by ${sms?.ok ? 'text' : 'app notification'}`,
    metadata: { notificationKey, sms: sms?.ok === true, push: push?.ok === true, smsSkipped: sms?.skipped || null },
  }).catch(() => {});
  return 'sent';
}

async function alertOwner(sb, booking, minutes) {
  const notificationKey = startOverdueKey(booking);
  const { data: easer } = await sb.from('profiles').select('phone').eq('id', booking.assembler_id).maybeSingle();
  const easerName = esc(booking.assembler_name || 'The assigned Easer');
  const easerPhone = formatUsPhone(easer?.phone || null);
  const mins = Math.round(minutes);
  const result = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase System <booking@assembleatease.com>',
    subject: `Job not started — ${booking.ref} (${booking.assembler_name || 'Easer'})`,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;border-top:4px solid #f59e0b"><tr><td style="padding:24px">
    <p style="margin:0 0 6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#b45309">Job Not Started</p>
    <p style="margin:0 0 16px;font-size:20px;font-weight:700">${esc(booking.ref)} &bull; ${esc(booking.service || '')}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">
      <strong>${easerName}</strong> tapped Arrived ${mins} minutes ago and has not tapped Start Job. They were sent a reminder at ${START_NUDGE_AFTER_MINUTES} minutes. The job cannot be completed or the payment captured until it is started.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;font-size:14px;margin-bottom:18px"><tr><td style="padding:14px 18px">
      <table width="100%"><tr><td style="padding:4px 0;color:#71717a;width:90px">Easer</td><td style="padding:4px 0">${easerName}${easerPhone ? ' &bull; <a href="tel:' + esc(easer.phone) + '" style="color:#00BFFF">' + esc(easerPhone) + '</a>' : ''}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Customer</td><td style="padding:4px 0">${esc(booking.customer_name || '')}</td></tr>
        <tr><td style="padding:4px 0;color:#71717a">Address</td><td style="padding:4px 0">${esc(formatAddress(booking.address || ''))}</td></tr>
      </table>
    </td></tr></table>
    <p style="margin:0 0 4px;font-size:13px;color:#52525b;line-height:1.7"><strong>What to do:</strong> Call the Easer and ask them to tap Start Job.</p>
    <a href="https://www.assembleatease.com/owner/" style="display:inline-block;margin-top:12px;background:#00BFFF;color:#fff;padding:11px 26px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700">Open Dashboard</a>
  </td></tr></table>
</div></body></html>`,
    replyTo: ownerEmail(),
    meta: { bookingId: booking.id, notificationType: 'start_overdue_alert', recipientType: 'owner', notificationKey, routine: false },
  });
  if (result?.suppressed) return 'already_sent';
  if (result?.deferred) return 'pending';
  if (!result?.ok) {
    await logActivity(sb, {
      bookingId: booking.id, eventType: 'start_overdue_alert_failed', actorType: 'system', actorName: 'start-nudge',
      description: 'Job not started alert: owner email delivery was not confirmed. Review the delivery log.',
      metadata: { notificationKey, error: result?.error || result?.reason || 'send_failed' },
    }).catch(() => {});
    return 'failed';
  }
  await logActivity(sb, {
    bookingId: booking.id, eventType: 'start_overdue_flagged', actorType: 'system', actorName: 'start-nudge',
    description: `${booking.assembler_name || 'Easer'} arrived ${mins} min ago and has not started the job. Owner email accepted for delivery.`,
    metadata: { notificationKey, minutesSinceArrival: mins },
  }).catch(() => {});
  return 'sent';
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== 'Bearer ' + cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const sb = getSupabase();
  let nudged = 0;
  let alerted = 0;
  let failed = 0;
  const skipped = [];

  try {
    const now = Date.now();
    const { data: candidates, error } = await sb.from('bookings')
      .select(BOOKING_SELECT)
      .eq('status', BOOKING_STATUS.ARRIVED)
      .not('assembler_id', 'is', null)
      .is('job_started_at', null)
      .gte('checked_in_at', new Date(now - LOOKBACK_HOURS * 3600000).toISOString());
    if (error) throw error;

    for (const candidate of candidates || []) {
      if (minutesWaitingForStart(candidate, now) == null) continue;
      const leaseKey = `start-nudge:${candidate.id}`;
      const lease = await acquireNotificationLease(sb, leaseKey);
      if (!lease?.ok) {
        if (lease?.error) failed++;
        skipped.push({ ref: candidate.ref, why: lease?.reason || 'claim_lost' });
        continue;
      }
      try {
        // Reload after claiming: the Easer may have started, or the job moved.
        const { data: booking, error: reloadError } = await sb.from('bookings')
          .select(BOOKING_SELECT).eq('id', candidate.id).maybeSingle();
        if (reloadError) throw reloadError;
        if (!booking || booking.assembler_id !== candidate.assembler_id
            || booking.checked_in_at !== candidate.checked_in_at) continue;
        const minutes = minutesWaitingForStart(booking, Date.now());
        if (minutes == null) continue;

        // The Easer is asked between 10 and 30 minutes; after that it is the owner's.
        if (minutes < OWNER_ALERT_AFTER_MINUTES) {
          const easerResult = await nudgeEaser(sb, booking, skipped);
          if (easerResult === 'sent') nudged++;
          if (easerResult === 'failed') failed++;
        }

        if (minutes >= OWNER_ALERT_AFTER_MINUTES) {
          const ownerResult = await alertOwner(sb, booking, minutes);
          if (ownerResult === 'sent') alerted++;
          if (ownerResult === 'failed') failed++;
        }
      } catch (err) {
        failed++;
        console.error('[easer-start-nudge] booking failed:', candidate.ref, err?.message || err);
        skipped.push({ ref: candidate.ref, why: 'delivery_or_recording_failed' });
      } finally {
        await releaseNotificationLease(sb, leaseKey, lease.token);
      }
    }

    await logCron('easer-start-nudge', { status: failed ? 'error' : 'ok', records: nudged + alerted, errorText: failed ? `${failed} start reminder(s) failed; retry required` : null, duration: Date.now() - startedAt });
    return res.status(200).json({ ok: failed === 0, nudged, alerted, failed, skipped });
  } catch (err) {
    console.error('[easer-start-nudge] failed:', err?.message || err);
    await logCron('easer-start-nudge', { status: 'error', records: nudged + alerted, errorText: err?.message || String(err), duration: Date.now() - startedAt });
    return res.status(500).json({ error: 'Start reminder run failed' });
  }
}
