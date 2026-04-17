import { getSupabase } from '../_supabase.js';

/**
 * GET /api/booking/customer-bookings
 * Returns bookings for the authenticated customer (matched by email).
 * Requires Authorization: Bearer <supabase-jwt>
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = auth.slice(7);
  const sb = getSupabase();

  // Verify JWT and get user
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const email = user.email?.toLowerCase();
  if (!email) {
    return res.status(400).json({ error: 'No email associated with account' });
  }

  const { status } = req.query;

  let query = sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_email, date, time, address, details, status, created_at, assembler_id, assigned_at, assembler_accepted_at')
    .eq('customer_email', email)
    .order('created_at', { ascending: false });

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Customer bookings error:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

  // Enrich with assembler names where assigned
  const bookings = data || [];
  const assemblerIds = [...new Set(bookings.filter(b => b.assembler_id).map(b => b.assembler_id))];

  let assemblerMap = {};
  if (assemblerIds.length) {
    const { data: assemblers } = await sb
      .from('profiles')
      .select('id, full_name')
      .in('id', assemblerIds);
    if (assemblers) {
      assemblers.forEach(a => { assemblerMap[a.id] = a.full_name; });
    }
  }

  const enriched = bookings.map(b => ({
    ...b,
    assembler_name: assemblerMap[b.assembler_id] || null,
  }));

  // Compute stats
  const stats = {
    total: bookings.length,
    pending: bookings.filter(b => b.status === 'pending').length,
    confirmed: bookings.filter(b => b.status === 'confirmed').length,
    completed: bookings.filter(b => b.status === 'completed').length,
  };

  return res.status(200).json({ bookings: enriched, stats });
}
