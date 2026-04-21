import { getSupabase } from '../_supabase.js';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/booking/my-assignments
 * Returns bookings assigned to the authenticated assembler.
 * Requires Bearer JWT auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const sb = getSupabase();

  // Optional status filter via ?status=confirmed or ?status=completed
  // Default: return all assigned bookings (all statuses)
  const statusFilter = req.query?.status || null;

  let query = sb
    .from('bookings')
    .select('id, ref, service, customer_name, date, time, address, details, status, assigned_at, assembler_accepted_at, completed_at, checked_in_at')
    .eq('assembler_id', user.id)
    .order('assigned_at', { ascending: false });

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query;

  if (error) {
    console.error('My assignments error:', error);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }

  return res.status(200).json({ bookings: data || [] });
}
