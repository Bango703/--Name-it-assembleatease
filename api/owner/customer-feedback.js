import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * GET /api/owner/customer-feedback — what Easers said about customers (owner only).
 *   ?bookingId=…   feedback on one booking
 *   (none)         the most recent flags
 * Easers write it through api/booking/customer-feedback.js (migration 110).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.setHeader('Cache-Control', 'private, no-store');

  const sb = getSupabase();
  const bookingId = req.query?.bookingId;
  let query = sb.from('customer_feedback')
    .select('id, booking_id, easer_id, rating, flagged, flag_reason, note, created_at')
    .order('created_at', { ascending: false });
  query = bookingId ? query.eq('booking_id', bookingId) : query.eq('flagged', true).limit(50);
  const { data, error } = await query;
  if (error) {
    return res.status(200).json({ ok: true, feedback: [], unavailable: true });
  }
  const easerIds = [...new Set((data || []).map(r => r.easer_id))];
  const names = new Map();
  if (easerIds.length) {
    const { data: easers } = await sb.from('profiles').select('id, full_name').in('id', easerIds);
    (easers || []).forEach(e => names.set(e.id, e.full_name || 'Easer'));
  }
  return res.status(200).json({
    ok: true,
    feedback: (data || []).map(r => ({
      id: r.id,
      bookingId: r.booking_id,
      easerName: names.get(r.easer_id) || 'Easer',
      rating: r.rating,
      flagged: r.flagged,
      flagReason: r.flag_reason,
      note: r.note,
      createdAt: r.created_at,
    })),
  });
}
