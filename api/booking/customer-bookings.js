import { getSupabase } from '../_supabase.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { customerOwnsBooking, normalizeCustomerEmail } from './_customer-booking-auth.js';

/**
 * GET /api/booking/customer-bookings
 * Returns bookings for the authenticated customer. Bound bookings are owned
 * by customer_id; exact email matching is only a legacy fallback for rows that
 * have not yet been bound to an account.
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

  const email = normalizeCustomerEmail(user.email);
  if (!email) {
    return res.status(400).json({ error: 'No email associated with account' });
  }

  const { status } = req.query;

  const select = 'id, ref, service, customer_name, customer_email, date, time, address, details, status, created_at, assembler_id, assigned_at, assembler_accepted_at';
  const applyStatus = query => (status && status !== 'all' ? query.eq('status', status) : query);
  const [boundResult, legacyResult] = await Promise.all([
    applyStatus(sb.from('bookings').select(select).eq('customer_id', user.id)),
    applyStatus(sb.from('bookings').select(select).is('customer_id', null).ilike('customer_email', email)),
  ]);

  if (boundResult.error || legacyResult.error) {
    console.error('Customer bookings error:', boundResult.error || legacyResult.error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

  // Enrich with assembler names where assigned
  const bookings = [...new Map([
    ...(boundResult.data || []),
    ...(legacyResult.data || []),
  ].filter(booking => customerOwnsBooking(booking, user)).map(booking => [booking.id, booking])).values()]
    .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
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
  const CONFIRMED_OR_IN_FLIGHT = new Set([
    BOOKING_STATUS.CONFIRMED,
    BOOKING_STATUS.EN_ROUTE,
    BOOKING_STATUS.ARRIVED,
    BOOKING_STATUS.IN_PROGRESS,
  ]);

  const stats = {
    total: bookings.length,
    pending: bookings.filter(b => b.status === BOOKING_STATUS.PENDING).length,
    confirmed: bookings.filter(b => CONFIRMED_OR_IN_FLIGHT.has(b.status)).length,
    completed: bookings.filter(b => b.status === BOOKING_STATUS.COMPLETED).length,
  };

  return res.status(200).json({ bookings: enriched, stats });
}
