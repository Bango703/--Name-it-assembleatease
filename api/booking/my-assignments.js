import { getSupabase } from '../_supabase.js';

/**
 * GET /api/booking/my-assignments?assemblerId=xxx
 * Returns bookings assigned to a specific assembler.
 * Only returns confirmed bookings with an active assignment.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { assemblerId } = req.query;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const sb = getSupabase();

  const { data, error } = await sb
    .from('bookings')
    .select('id, ref, service, customer_name, date, time, address, details, status, assigned_at, assembler_accepted_at')
    .eq('assembler_id', assemblerId)
    .eq('status', 'confirmed')
    .order('assigned_at', { ascending: false });

  if (error) {
    console.error('My assignments error:', error);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }

  return res.status(200).json({ bookings: data || [] });
}
