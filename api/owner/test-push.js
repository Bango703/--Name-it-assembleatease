import { sendPushToUser } from '../_push.js';
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(403).json({ error: 'Unauthorized' });

  try {
    const sb = getSupabase();
    const { userId } = req.body || {};

    let query = sb.from('push_subscriptions').select('user_id, endpoint, p256dh, auth');
    if (userId) query = query.eq('user_id', userId);
    const { data: subs, error: dbErr } = await query.limit(50);

    if (dbErr) return res.status(200).json({ ok: false, error: 'DB: ' + dbErr.message });
    if (!subs || !subs.length) {
      return res.status(200).json({ ok: false, sent: 0, message: 'No subscriptions found. Open the Easer app and allow notifications.' });
    }

    const unique = [...new Set(subs.map(s => s.user_id))];
    const errors = [];

    for (const uid of unique) {
      try {
        await sendPushToUser(uid, {
          title: 'AssembleAtEase — Test',
          body: 'Push notifications are working! You will be notified the moment a job is assigned.',
          url: '/assembler/my-assignments',
          jobId: 'test-' + Date.now(),
          urgent: false,
        });
      } catch(e) {
        errors.push({ uid, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      sent: unique.length,
      subscriptions: subs.length,
      errors,
    });

  } catch(e) {
    return res.status(200).json({ ok: false, crash: e.message, stack: e.stack });
  }
}
