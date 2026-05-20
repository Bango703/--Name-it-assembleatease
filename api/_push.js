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
 */
export async function sendPushToUser(userId, payload) {
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

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message,
        { TTL: 3600 } // keep in queue 1 hour if device offline
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        dead.push(s.endpoint); // subscription expired — clean up
      } else {
        console.error('Push send error:', e.statusCode, e.body);
      }
    }
  }));

  // Remove expired subscriptions
  if (dead.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', dead);
  }
}
