import { getSupabase } from '../_supabase.js';

/**
 * POST /api/assembler/push-subscribe
 * Save or delete a push subscription for the authenticated Easer.
 * Body: { userId, subscription } to save, { userId, endpoint } to delete.
 */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Return the VAPID public key so the client can subscribe
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(500).json({ error: 'Push notifications not configured' });
    return res.status(200).json({ publicKey: key });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, subscription, action } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const sb = getSupabase();

  // DELETE — unsubscribe
  if (action === 'unsubscribe' && subscription?.endpoint) {
    await sb.from('push_subscriptions').delete()
      .eq('user_id', userId).eq('endpoint', subscription.endpoint);
    return res.status(200).json({ ok: true });
  }

  // SAVE — upsert subscription
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  const { error } = await sb.from('push_subscriptions').upsert({
    user_id:  userId,
    endpoint: subscription.endpoint,
    p256dh:   subscription.keys.p256dh,
    auth:     subscription.keys.auth,
  }, { onConflict: 'endpoint' });

  if (error) {
    console.error('Push subscribe error:', error);
    return res.status(500).json({ error: 'Failed to save subscription' });
  }

  return res.status(200).json({ ok: true });
}
