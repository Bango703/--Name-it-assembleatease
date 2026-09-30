import { getSupabase } from '../_supabase.js';
import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';

/**
 * Register / unregister the installed Easer app for native push.
 *   POST   { token, platform: 'ios'|'android', appVersion? } → this device gets
 *          this Easer's job notifications (a device used by another Easer before
 *          moves to the one signed in now)
 *   DELETE { token } → sign-out on this device; it stops receiving them
 * Called only by the app (assets/js/native-app.js); the website never calls it.
 */
function tableMissing(error) {
  return error && (['42P01', 'PGRST205', 'PGRST204'].includes(error.code) || /native_push_tokens|schema cache/i.test(String(error.message || '')));
}

export default async function handler(req, res) {
  if (!['POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authed = await authenticateBearerUser(req);
  if (!authed.ok) return respondWithEaserAccessError(res, authed);

  const token = String(req.body?.token || '').trim();
  if (!token || token.length > 4096) return res.status(400).json({ error: 'A device token is required.' });
  const sb = getSupabase();

  if (req.method === 'DELETE') {
    const { error } = await sb.from('native_push_tokens').delete().eq('token', token).eq('user_id', authed.user.id);
    if (error && !tableMissing(error)) return res.status(503).json({ error: 'The device could not be signed out of notifications.' });
    return res.status(200).json({ ok: true });
  }

  const platform = String(req.body?.platform || '').toLowerCase();
  if (!['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'platform must be ios or android' });
  const { data: profile, error: profileError } = await sb.from('profiles').select('id, role').eq('id', authed.user.id).maybeSingle();
  if (profileError) return res.status(503).json({ error: 'Your account could not be checked.' });
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'Easer access required' });

  const { error } = await sb.from('native_push_tokens').upsert({
    user_id: profile.id,
    token,
    platform,
    app_version: String(req.body?.appVersion || '').slice(0, 40) || null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'token' });
  if (error) {
    if (tableMissing(error)) return res.status(503).json({ error: 'App notifications are not switched on yet.', code: 'NATIVE_PUSH_NOT_READY' });
    return res.status(503).json({ error: 'This device could not be registered for notifications.' });
  }
  return res.status(200).json({ ok: true });
}
