import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { customerAccountUser, customerBookingAccess } from '../booking/_customer-access.js';

/**
 * The customer app's notification registration (api/_customer-push.js sends).
 *   POST   { token, platform, appVersion? }      this phone gets booking updates
 *   POST   { activityToken, fcmToken, ref }      a lock-screen tracker for one booking
 *   DELETE { token }                             sign-out: this phone stops getting them
 * Signed-in customers only; a tracker only for a booking the customer owns.
 */
function tableMissing(error) {
  return !!error && (['42P01', 'PGRST205', 'PGRST204'].includes(error.code) || /customer_push_tokens|customer_live_activities|schema cache/i.test(String(error.message || '')));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await rateLimit(ip, 'default'))) return res.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });

  const sb = getSupabase();
  const user = await customerAccountUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to turn on notifications.' });
  const body = req.body || {};

  if (req.method === 'DELETE') {
    const token = String(body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'A device token is required.' });
    const { error } = await sb.from('customer_push_tokens').delete().eq('token', token).eq('user_id', user.id);
    if (error && !tableMissing(error)) return res.status(503).json({ error: 'Notifications could not be turned off on this phone.' });
    return res.status(200).json({ ok: true });
  }

  if (body.activityToken) {
    const activityToken = String(body.activityToken).trim();
    const fcmToken = String(body.fcmToken || '').trim();
    const ref = String(body.ref || '').trim().toUpperCase();
    if (!activityToken || activityToken.length > 4096 || !fcmToken || !ref) {
      return res.status(400).json({ error: 'The tracker could not be started.' });
    }
    const { data: booking } = await sb.from('bookings').select('id, ref, customer_id, customer_email').eq('ref', ref).maybeSingle();
    if (!booking || !(await customerBookingAccess(sb, req, booking)).ok) return res.status(404).json({ error: 'Booking not found' });
    const { error } = await sb.from('customer_live_activities').upsert({
      booking_id: booking.id,
      user_id: user.id,
      fcm_token: fcmToken,
      activity_token: activityToken,
      ended_at: null,
    }, { onConflict: 'activity_token' });
    if (error) {
      if (tableMissing(error)) return res.status(503).json({ error: 'Live tracking is not switched on yet.', code: 'CUSTOMER_PUSH_NOT_READY' });
      return res.status(503).json({ error: 'The tracker could not be started.' });
    }
    return res.status(200).json({ ok: true });
  }

  const token = String(body.token || '').trim();
  const platform = String(body.platform || '').toLowerCase();
  if (!token || token.length > 4096) return res.status(400).json({ error: 'A device token is required.' });
  if (!['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'platform must be ios or android' });
  const { error } = await sb.from('customer_push_tokens').upsert({
    user_id: user.id,
    email: String(user.email || '').trim().toLowerCase(),
    token,
    platform,
    app_version: String(body.appVersion || '').slice(0, 40) || null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'token' });
  if (error) {
    if (tableMissing(error)) return res.status(503).json({ error: 'Notifications are not switched on yet.', code: 'CUSTOMER_PUSH_NOT_READY' });
    return res.status(503).json({ error: 'This phone could not be registered for notifications.' });
  }
  return res.status(200).json({ ok: true });
}
