import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(403).json({ error: 'Unauthorized' });

  // Configure VAPID
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const mail = process.env.VAPID_EMAIL || 'mailto:service@assembleatease.com';
  if (!pub || !priv) return res.status(500).json({ error: 'VAPID keys not configured' });
  webpush.setVapidDetails(mail, pub, priv);

  const sb = getSupabase();

  // Get all subscriptions (or filter by userId)
  const { userId } = req.body || {};
  let query = sb.from('push_subscriptions').select('user_id, endpoint, p256dh, auth');
  if (userId) query = query.eq('user_id', userId);
  const { data: subs, error: dbErr } = await query.limit(50);

  if (dbErr) return res.status(500).json({ error: 'DB error: ' + dbErr.message });
  if (!subs || !subs.length) {
    return res.status(200).json({ ok: false, sent: 0, message: 'No subscriptions found. Open the Easer app and allow notifications first.' });
  }

  const payload = JSON.stringify({
    title: 'Test Notification',
    body: 'Push notifications are working! You will be notified the moment a job is assigned.',
    url: '/assembler/my-assignments',
    jobId: 'test-' + Date.now(),
    urgent: false,
  });

  const results = [];
  const dead = [];

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 }
      );
      results.push({ user_id: s.user_id, status: 'sent' });
    } catch(e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        dead.push(s.endpoint);
        results.push({ user_id: s.user_id, status: 'expired', code: e.statusCode });
      } else {
        results.push({ user_id: s.user_id, status: 'error', code: e.statusCode, body: e.body });
      }
    }
  }

  // Clean dead subscriptions
  if (dead.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', dead);
  }

  const sent = results.filter(r => r.status === 'sent').length;
  return res.status(200).json({ ok: true, sent, total: subs.length, results });
}
