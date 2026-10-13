import { getSupabase } from '../_supabase.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { customerOwnsBooking, normalizeCustomerEmail } from './_customer-booking-auth.js';
import { customerAccountUser } from './_customer-access.js';
import { customerStatusLabel } from './_customer-status.js';

/**
 * GET /api/booking/customer-bookings
 * Returns bookings for the authenticated customer. Bound bookings are owned
 * by customer_id; exact email matching is only a legacy fallback for rows that
 * have not yet been bound to an account.
 * Requires Authorization: Bearer <supabase-jwt>
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const sb = getSupabase();
  // Only a confirmed email proves the bookings sent to it are this person's
  // (api/booking/_customer-access.js, the customer app's sign-in).
  const user = await customerAccountUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to see your bookings.' });

  const email = normalizeCustomerEmail(user.email);
  if (!email) {
    return res.status(400).json({ error: 'No email associated with account' });
  }

  const { status } = req.query;

  const select = 'id, ref, service, customer_id, customer_name, customer_email, date, time, address, details, status, created_at, assembler_id, assembler_name, assembler_accepted_at, payment_status, payment_collected, return_visit_required, return_visit_date, return_visit_time';
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
  // What the customer sees of each booking: the same status words as the
  // booking page, and the pro's first name only once they have accepted.
  const enriched = bookings.map(b => {
    const status = customerStatusLabel(b);
    return {
      id: b.id,
      ref: b.ref,
      service: b.service,
      date: b.date,
      time: b.time,
      address: b.address,
      details: b.details,
      status: b.status,
      created_at: b.created_at,
      customer_status: status.label,
      customer_status_detail: status.detail,
      pro_first_name: b.assembler_accepted_at && b.assembler_name ? String(b.assembler_name).split(' ')[0] : null,
    };
  });

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
