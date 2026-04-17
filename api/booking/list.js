import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { status, limit, offset } = req.query;

  let query = sb
    .from('bookings')
    .select('*, messages(count)')
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);
  if (limit) query = query.limit(parseInt(limit, 10));
  if (offset) query = query.range(parseInt(offset, 10), parseInt(offset, 10) + parseInt(limit || 25, 10) - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('List bookings error:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

  return res.status(200).json({ bookings: data || [], count });
}
