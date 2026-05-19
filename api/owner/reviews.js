import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  // PATCH — toggle approved or featured
  if (req.method === 'PATCH') {
    const { id, approved, featured } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const updates = {};
    if (approved !== undefined) updates.approved = approved;
    if (featured !== undefined) updates.featured = featured;
    const { error } = await sb.from('reviews').update(updates).eq('id', id);
    if (error) return res.status(500).json({ error: 'Failed to update review' });
    return res.status(200).json({ success: true });
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const { error } = await sb.from('reviews').delete().eq('id', id);
    if (error) return res.status(500).json({ error: 'Failed to delete review' });
    return res.status(200).json({ success: true });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { data, error } = await sb
    .from('reviews')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Failed to fetch reviews' });
  return res.status(200).json({ reviews: data || [] });
}
