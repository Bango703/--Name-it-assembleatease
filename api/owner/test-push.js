import { sendPushToUser } from '../_push.js';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(403).json({ error: 'Unauthorized' });

  const { userId } = req.body;

  if (userId) {
    // Send to a specific user
    await sendPushToUser(userId, {
      title: 'Test Notification',
      body: 'Push notifications are working! You will be notified instantly when a job is assigned.',
      url: '/assembler/my-assignments',
      jobId: 'test-' + Date.now(),
      urgent: false,
    });
    return res.status(200).json({ ok: true, sent: 1 });
  }

  // No userId — send to ALL Easers with subscriptions
  const sb = getSupabase();
  const { data: subs } = await sb
    .from('push_subscriptions')
    .select('user_id')
    .limit(50);

  if (!subs || !subs.length) {
    return res.status(200).json({ ok: true, sent: 0, message: 'No subscriptions found. Easer must allow notifications first.' });
  }

  const unique = [...new Set(subs.map(s => s.user_id))];
  await Promise.all(unique.map(uid => sendPushToUser(uid, {
    title: 'Test Notification',
    body: 'Push notifications are working! You will be notified instantly when a job is assigned.',
    url: '/assembler/my-assignments',
    jobId: 'test-' + Date.now(),
    urgent: false,
  })));

  return res.status(200).json({ ok: true, sent: unique.length });
}
