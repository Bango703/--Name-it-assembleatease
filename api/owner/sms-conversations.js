import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!(await rateLimit(ip, 'default'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  const { data, error } = await sb.from('sms_conversations')
    .select('id, phone, customer_name, customer_email, booking_id, easer_id, status, last_message_at, last_message_preview, unread_count, created_at, updated_at, bookings(id, ref, service, status), profiles(id, full_name, email)')
    .order('last_message_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('Owner SMS conversation list error:', error);
    return res.status(503).json({ error: 'SMS conversations could not be loaded. The migration may not be applied yet.' });
  }
  return res.status(200).json({ conversations: data || [] });
}
