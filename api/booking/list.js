import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { status, limit, offset } = req.query;
  const safeLimit  = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let query = sb
    .from('bookings')
    .select('*, messages(count)', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (status && status !== 'all') query = query.eq('status', status);
  query = query.range(safeOffset, safeOffset + safeLimit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('List bookings error:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

  // Enrich with assembler name/tier/rating — separate query avoids FK constraint uncertainty
  if (data && data.length) {
    const aIds = [...new Set(data.filter(b => b.assembler_id).map(b => b.assembler_id))];
    if (aIds.length) {
      const { data: profiles } = await sb
        .from('profiles')
        .select('id, full_name, tier, rating, completed_jobs, phone')
        .in('id', aIds);
      if (profiles) {
        const pm = {};
        profiles.forEach(p => { pm[p.id] = p; });
        data.forEach(b => {
          if (b.assembler_id && pm[b.assembler_id]) {
            b.assembler_name  = pm[b.assembler_id].full_name;
            b.assembler_tier  = pm[b.assembler_id].tier;
            b.assembler_rating= pm[b.assembler_id].rating;
            b.assembler_jobs  = pm[b.assembler_id].completed_jobs;
            b.assembler_phone = pm[b.assembler_id].phone || null;
          }
        });
      }
    }
  }

  return res.status(200).json({ bookings: data || [], count });
}
