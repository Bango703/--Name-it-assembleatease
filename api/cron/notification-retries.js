import { getSupabase } from '../_supabase.js';
import { sendEmail } from '../_email.js';
import { sendSms, smsEligibility } from '../_sms.js';
import { cancelQueuedNotification } from '../_notification-policy.js';
import { notificationRetryEligibility } from '../_notification-retry-eligibility.js';
import { logCron } from './_cron-logger.js';

export const config = { maxDuration: 60 };

// Only the shared reservation RPC may authorize a provider attempt. Cron
// overlap, quiet hours, retry limits and channel dedupe stay in that one place.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now(), now = new Date(), sb = getSupabase();
  const { data: rows, error } = await sb.from('notification_log')
    .select('id,channel,booking_id,recipient_type,recipient_email,recipient_user_id,notification_type,status,send_payload,send_expires_at,next_attempt_at')
    .in('status', ['deferred', 'failed', 'queued']).not('send_payload', 'is', null)
    .lte('next_attempt_at', now.toISOString()).order('next_attempt_at').limit(40);
  if (error) return res.status(503).json({ error: 'Notification retry queue unavailable.' });
  let accepted = 0, cancelled = 0, deferred = 0, uncertain = 0;
  const errors = [];
  const stop = async (row, reason) => {
    const result = await cancelQueuedNotification(sb, row.id, reason);
    if (!result.ok) errors.push({ id: row.id, error: result.error });
    else if (result.status === 'uncertain') uncertain++;
    else cancelled++;
  };
  for (const row of rows || []) {
    if (Date.now() - started > 35000) break;
    try {
      if (row.channel === 'sms' && row.status === 'queued') {
        await stop(row, 'Previous SMS outcome unknown; verify provider delivery before retrying.');
        continue;
      }
      if (row.send_expires_at && new Date(row.send_expires_at) <= now) {
        await stop(row, 'Notification retry window expired; review provider delivery and any remaining follow-up.');
        continue;
      }
      const payload = row.send_payload;
      let booking = null;
      if (row.booking_id) {
        const { data, error: loadError } = await sb.from('bookings').select('*').eq('id', row.booking_id).maybeSingle();
        if (loadError) throw loadError;
        booking = data;
        if (!booking) {
          await stop(row, 'Booking no longer exists.'); continue;
        }
      }
      const eligible = await notificationRetryEligibility(sb, row, payload, booking, now);
      if (!eligible.ok) {
        if (eligible.retryable) {
          const { data: updated, error: deferError } = await sb.from('notification_log').update({ next_attempt_at: new Date(now.getTime() + 900000).toISOString(), error_text: eligible.reason })
            .eq('id', row.id).in('status', ['deferred', 'failed', 'queued'])
            .or(`claim_expires_at.is.null,claim_expires_at.lte.${now.toISOString()}`).select('id');
          if (deferError || !updated?.length) errors.push({ id: row.id, error: deferError?.message || 'Notification claim changed.' });
          else deferred++;
        } else {
          await stop(row, eligible.reason);
        }
        continue;
      }
      let recipient = null;
      if (row.recipient_type === 'easer' && row.recipient_user_id) {
        const { data, error: profileError } = await sb.from('profiles')
          .select('id,email,phone,sms_consent_at,sms_opted_out_at').eq('id', row.recipient_user_id).eq('role', 'assembler').maybeSingle();
        if (profileError) throw profileError;
        recipient = data;
        if (!recipient || (row.channel === 'email' && String(recipient.email || '').trim().toLowerCase() !== row.recipient_email)) {
          await stop(row, 'Recipient changed or no longer exists.'); continue;
        }
      } else if (row.recipient_type === 'customer' && booking) {
        recipient = { phone: booking.customer_phone, sms_consent_at: booking.sms_consent_at, sms_opted_out_at: booking.sms_opted_out_at };
      }
      let outcome;
      if (row.channel === 'email' && payload.kind === 'email') {
        outcome = await sendEmail({ ...payload.original, meta: payload.meta });
      } else if (row.channel === 'sms' && payload.kind === 'sms') {
        const sms = smsEligibility(recipient || {});
        if (!sms.ok || sms.phone !== payload.body.to) {
          await stop(row, sms.reason || 'SMS recipient changed.'); continue;
        }
        outcome = await sendSms({ recipient, body: payload.original.body, meta: payload.meta });
      } else {
        await stop(row, 'Unsupported queued notification.'); continue;
      }
      if (outcome.ok) {
        accepted++;
        if (row.notification_type === 'dispatch_offer' && payload.meta?.expiresAt) {
          const { error: projectionError } = await sb.from('dispatch_offers').update({ notification_sent: true })
            .eq('booking_id', row.booking_id).eq('easer_id', row.recipient_user_id).eq('expires_at', payload.meta.expiresAt);
          if (projectionError) errors.push({ id: row.id, error: 'Offer notification accepted, but dispatch history update failed: ' + projectionError.message });
        }
      }
      else if (outcome.deferred || outcome.retryScheduled) deferred++;
      else {
        if (outcome.uncertain) uncertain++;
        errors.push({ id: row.id, error: outcome.error || outcome.skipped });
      }
    } catch (failure) {
      errors.push({ id: row.id, error: failure.message });
    }
    // Leave remaining due rows for the next run instead of exceeding the cron budget.
    if (Date.now() - started > 45000) break;
  }
  await logCron('notification-retries', { status: errors.length ? 'warning' : 'ok', records: accepted,
    error: errors.length ? JSON.stringify(errors).slice(0, 1000) : null, duration: Date.now() - started });
  return res.status(200).json({ ok: true, accepted, cancelled, deferred, uncertain, errors });
}
