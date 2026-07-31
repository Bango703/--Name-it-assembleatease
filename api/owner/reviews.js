import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  // PATCH — toggle approved or featured
  if (req.method === 'PATCH') {
    const { id, approved, featured } = req.body || {};
    if (!isUuid(id)) return res.status(400).json({ error: 'A valid review id is required' });
    const updates = {};
    if (typeof approved === 'boolean') updates.approved = approved;
    if (typeof featured === 'boolean') updates.featured = featured;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'A boolean approved or featured value is required' });
    const { error, data } = await sb.from('reviews').update(updates).eq('id', id).select('id');
    if (error) return res.status(500).json({ error: 'Failed to update review' });
    if (!data?.length) return res.status(404).json({ error: 'Review not found' });
    return res.status(200).json({ success: true });
  }

  // Reviews are customer/business records. Hide them through PATCH rather than
  // destroying the only moderation trail from the operating dashboard.
  if (req.method === 'DELETE') {
    return res.status(405).json({ error: 'Reviews must be hidden, not permanently deleted.' });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { data, error } = await sb
    .from('reviews')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch reviews' });
  return res.status(200).json({ reviews: data || [] });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}
