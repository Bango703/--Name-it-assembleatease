import { getSupabase } from '../_supabase.js';

export default async function handler(req, res) {
  try {
  if (req.method === 'GET') {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not set in environment' });
    return res.status(200).json({ publicKey: key, ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Require Bearer JWT — userId from token, never from body
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const sb = getSupabase();
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  // Verify Easer role
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'Forbidden' });

  const userId = user.id;
  const { subscription, action } = req.body;

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
  } catch(e) {
    console.error('push-subscribe crash:', e);
    return res.status(500).json({ error: e.message || String(e) });
  }
}
