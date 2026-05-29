import webpush from 'web-push';
import { getSupabase } from './_supabase.js';

let _configured = false;
function configure() {
  if (_configured) return;
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const mail = process.env.VAPID_EMAIL || 'mailto:service@assembleatease.com';
  if (!pub || !priv) throw new Error('VAPID keys not configured');
  webpush.setVapidDetails(mail, pub, priv);
  _configured = true;
}

/**
 * Send a push notification to all subscriptions for a given userId.
 * payload: { title, body, url, jobId, urgent }
 * meta (optional): { bookingId, notificationType, recipientType }
 */
export async function sendPushToUser(userId, payload, meta = {}) {
  try {
    configure();
  } catch (e) {
    console.warn('Push not configured — skipping:', e.message);
    return;
  }

  const sb = getSupabase();
  const { data: subs } = await sb
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (!subs || !subs.length) return;

  const message = JSON.stringify(payload);
  const dead = [];
  const logRows = [];

  await Promise.all(subs.map(async (s) => {
    let status = 'sent';
    let errorText = null;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message,
        { TTL: 3600 }
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        dead.push(s.endpoint);
        status = 'failed';
        errorText = 'Subscription expired (410/404)';
      } else {
        status = 'failed';
        errorText = String(e.statusCode || '') + ' ' + String(e.body || e.message || '');
        console.error('Push send error:', e.statusCode, e.body);
      }
    }
    logRows.push({
      channel:           'push',
      booking_id:        meta.bookingId        || null,
      notification_type: meta.notificationType || 'push',
      recipient_type:    meta.recipientType    || 'easer',
      recipient_user_id: userId,
      subject:           payload.title         || null,
      provider_id:       s.endpoint.slice(-40), // last 40 chars of endpoint as identifier
      status,
      error_text:        errorText,
    });
  }));

  // Await the log insert before returning — Vercel terminates execution after
  // response flush, so non-awaited inserts are abandoned and never reach the DB.
  // Supabase v2 returns { error } instead of throwing — check explicitly to surface failures.
  if (logRows.length) {
    const { error: logErr } = await sb.from('notification_log').insert(logRows)
      .catch(err => ({ error: err }));
    if (logErr) console.error('[push] notification_log insert failed:', logErr.message || logErr, logErr.code || '');
  }
  if (dead.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', dead);
  }
}
