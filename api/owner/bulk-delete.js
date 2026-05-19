import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * POST /api/owner/bulk-delete
 * Owner only: delete any bookings by ID regardless of status.
 * Body: { ids: string[] }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array is required' });

  const sb = getSupabase();

  // Delete related reviews first to avoid FK constraint
  await sb.from('reviews').delete().in('booking_id', ids);

  const { error } = await sb.from('bookings').delete().in('id', ids);
  if (error) {
    console.error('Bulk delete error:', error);
    return res.status(500).json({ error: 'Failed to delete bookings' });
  }

  console.log(JSON.stringify({ audit: true, action: 'bulk_delete', actor: 'owner', ids, count: ids.length, timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: true, deleted: ids.length });
}
