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

  const relatedTables = [
    ['reviews', 'booking_id'],
    ['booking_items', 'booking_id'],
    ['booking_evidence', 'booking_id'],
    ['booking_notes', 'booking_id'],
    ['dispatch_offers', 'booking_id'],
    ['activity_logs', 'booking_id'],
    ['notification_log', 'booking_id'],
    ['financial_event_audit', 'booking_id'],
    ['payout_ledger', 'booking_id'],
  ];

  for (const [table, column] of relatedTables) {
    const { error: relErr } = await sb.from(table).delete().in(column, ids);
    if (relErr && !['42P01', '42703'].includes(relErr.code)) {
      console.warn('Bulk delete related row cleanup warning:', table, relErr.message);
    }
  }

  const { error } = await sb.from('bookings').delete().in('id', ids);
  if (error) {
    console.error('Bulk delete error:', error);
    return res.status(500).json({ error: 'Failed to delete bookings' });
  }

  console.log(JSON.stringify({ audit: true, action: 'bulk_delete', actor: 'owner', ids, count: ids.length, timestamp: new Date().toISOString() }));
  return res.status(200).json({ ok: true, deleted: ids.length });
}
