import { getSupabase } from '../_supabase.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { customerOwnsBooking, normalizeCustomerEmail } from './_customer-booking-auth.js';
import { customerAccountBookings, customerAccountUser } from './_customer-access.js';
import { customerCheckoutUnfinished, customerProgress, customerStatusLabel } from './_customer-status.js';

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

  const select = 'id, ref, service, customer_id, customer_name, customer_email, date, time, address, details, status, created_at, assembler_id, assembler_name, assembler_accepted_at, payment_status, payment_collected, return_visit_required, return_visit_date, return_visit_time, stripe_payment_intent_id';
  const applyStatus = query => (status && status !== 'all' ? query.eq('status', status) : query);
  const { bookings: owned, error: listError } = await customerAccountBookings(sb, user, select, applyStatus);
  // An abandoned card checkout stays visible to the owner as an attempt, not to the customer as a booking.
  const bookings = owned.filter(b => !customerCheckoutUnfinished(b));
  if (listError) {
    console.error('Customer bookings error:', listError);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }

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
      customer_progress: customerProgress(b),
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

  // The name the customer booked under most recently, for the app's greeting.
  const customerFirstName = String(bookings.find(b => b.customer_name)?.customer_name || '').trim().split(/\s+/)[0] || null;

  return res.status(200).json({ bookings: enriched, stats, customer_first_name: customerFirstName });
}
