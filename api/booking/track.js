import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

/**
 * POST /api/booking/track
 * Guest booking lookup — no authentication required.
 * Verifies ownership via email + ref (two-factor without a password).
 * Body: { email, ref }
 * Returns sanitized booking fields only (no Stripe IDs, no payment methods).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ok = await rateLimit(ip, 'default');
  if (!ok) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref } = req.body || {};
  if (!email || !ref) {
    return res.status(400).json({ error: 'Email and booking reference are required.' });
  }

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .ilike('customer_email', email.trim())
    .maybeSingle();

  if (error) {
    console.error('Track lookup error:', { message: error.message, code: error.code, ref: ref.toUpperCase().trim() });
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking) {
    return res.status(404).json({
      error: 'No booking found with that reference and email. Double-check your confirmation email.',
    });
  }

  // Derive clean customer-facing status label
  function getCustomerLabel(b) {
    if (b.status === BOOKING_STATUS.CANCELLED) return { label: 'Booking cancelled', detail: null };
    if (b.status === BOOKING_STATUS.DECLINED)  return { label: 'Booking could not be confirmed', detail: 'Please contact us to reschedule.' };
    if (b.status === BOOKING_STATUS.COMPLETED) {
      const paymentProcessed = ['captured', 'deposit_paid'].includes(String(b.payment_status || '').toLowerCase());
      return {
        label: 'Job complete — thank you!',
        detail: paymentProcessed ? 'Payment has been processed.' : 'Your booking is complete.',
      };
    }
    if (b.status === BOOKING_STATUS.IN_PROGRESS) return { label: 'Work is underway', detail: null };
    if (b.status === BOOKING_STATUS.ARRIVED)     return { label: 'Your service pro has arrived', detail: null };
    if (b.status === BOOKING_STATUS.EN_ROUTE)    return { label: 'Your service pro is on the way', detail: null };
    if (b.assembler_accepted_at && b.assembler_name) {
      const first = (b.assembler_name || '').split(' ')[0];
      return { label: `${first} is confirmed for your job`, detail: `Arriving ${b.date}${b.time ? ' at ' + b.time.split('-')[0].trim() : ''}.` };
    }
    if (b.assembler_id) return { label: 'Matching you with a service pro', detail: 'Your pro will confirm shortly.' };
    if (b.status === BOOKING_STATUS.CONFIRMED) return { label: 'Matching you with a service pro', detail: 'We will notify you once your service pro is confirmed.' };
    return { label: 'Booking received', detail: 'We will confirm your appointment shortly.' };
  }

  const customerStatus = getCustomerLabel(booking);

  // Return only safe/public fields — never expose Stripe IDs, phone, raw payment data
  const safe = {
    id: booking.id,
    ref: booking.ref,
    status: booking.status,
    customer_status: customerStatus.label,
    customer_status_detail: customerStatus.detail,
    service: booking.service,
    date: booking.date,
    time: booking.time,
    customer_name: booking.customer_name,
    address: booking.address,
    city: booking.city || null,
    total_price: booking.total_price || null,
    deposit_amount: booking.deposit_amount || null,
    payment_status: booking.payment_status || null,
    created_at: booking.created_at,
    cancelled_at: booking.cancelled_at || null,
    completed_at: booking.completed_at || null,
    cancel_reason: booking.cancel_reason || null,
    cancellation_fee: booking.cancellation_fee || null,
    // Pro trust signal — first name only (never full name/phone to customer),
    // shown once the Pro has accepted the job.
    pro_first_name: (booking.assembler_accepted_at && booking.assembler_name)
      ? booking.assembler_name.split(' ')[0]
      : null,
    pro_verified: booking.identity_verified === true,
  };

  return res.status(200).json({ booking: safe });
}
