import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { safeTokenHashMatch } from '../_payment-security.js';
import { bookingEmailMatches } from './_guest-booking-auth.js';

/**
 * POST /api/booking/track
 * Guest booking lookup — no authentication required.
 * Verifies ownership via email + ref + the high-entropy token delivered to the
 * customer's email. Email and a guessable/displayed reference alone never
 * authorize access to an address, name, price, or booking state.
 * Body: { email, ref, token }
 * Returns sanitized booking fields only (no Stripe IDs, no payment methods).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const ok = await rateLimit(ip, 'default');
  if (!ok) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { email, ref, token } = req.body || {};
  if (!email || !ref || !token) {
    return res.status(400).json({ error: 'Open the secure link in your latest booking email, or request a new link below.' });
  }

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('*')
    .eq('ref', ref.toUpperCase().trim())
    .maybeSingle();

  if (error) {
    console.error('Track lookup error:', { message: error.message, code: error.code, ref: ref.toUpperCase().trim() });
    return res.status(500).json({ error: 'Unable to look up booking. Please try again.' });
  }
  if (!booking || !bookingEmailMatches(booking, email) || !safeTokenHashMatch(token, booking.guest_mutation_token_hash)) {
    return res.status(404).json({
      error: 'This secure booking link is invalid or expired. Request a new link and try again.',
    });
  }

  // Derive clean customer-facing status label
  function getCustomerLabel(b) {
    if (b.status === BOOKING_STATUS.CANCELLED) return { label: 'Booking cancelled', detail: null };
    if (b.status === BOOKING_STATUS.DECLINED)  return { label: 'Booking could not be confirmed', detail: 'Please contact us to reschedule.' };
    if (b.return_visit_required) {
      return {
        label: 'Return appointment scheduled',
        detail: `We will return ${b.return_visit_date || 'on the confirmed date'}${b.return_visit_time ? ` at ${b.return_visit_time}` : ''} to complete the remaining work.`,
      };
    }
    if (b.status === BOOKING_STATUS.COMPLETED) {
      const paymentProcessed = b.payment_collected === true
        || ['captured', 'deposit_paid', 'partially_refunded', 'refunded'].includes(String(b.payment_status || '').toLowerCase());
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

  let amountCollectedCents = null;
  let grossPaymentCents = null;
  let remainingBalanceCents = null;
  if (booking.source === 'owner_manual') {
    const { data: paymentEvents, error: paymentEventsError } = await sb
      .from('owner_manual_payment_events')
      .select('amount_cents, refunded_cents')
      .eq('booking_id', booking.id);
    if (paymentEventsError) {
      console.error('Customer owner-manual payment balance lookup failed:', paymentEventsError);
      return res.status(503).json({
        error: 'Your payment balance is temporarily unavailable. Please contact support before making another payment.',
        code: 'PAYMENT_BALANCE_UNAVAILABLE',
      });
    }
    const ledgerGross = (paymentEvents || []).reduce(
      (sum, event) => sum + Number(event.amount_cents || 0),
      0,
    );
    const ledgerRefunded = (paymentEvents || []).reduce(
      (sum, event) => sum + Number(event.refunded_cents || 0),
      0,
    );
    const ledgerNet = Math.max(0, ledgerGross - ledgerRefunded);
    grossPaymentCents = (paymentEvents || []).length ? ledgerGross : null;
    amountCollectedCents = (paymentEvents || []).length ? ledgerNet : (booking.payment_collected === true
      ? Number(booking.amount_charged ?? booking.total_price ?? 0)
      : 0);
    remainingBalanceCents = Math.max(0, Number(booking.total_price || 0) - amountCollectedCents);
  }

  // Has this booking been rescheduled? If so, free cancellation is forfeited —
  // the cancel UI must warn about the cancellation fee regardless of the 24h window.
  const rescheduleCount = Number(booking.reschedule_count);
  if (!Number.isInteger(rescheduleCount) || rescheduleCount < 0) {
    return res.status(503).json({
      error: 'Booking cancellation terms are temporarily unavailable. Please contact support before changing this appointment.',
      code: 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE',
    });
  }
  const wasRescheduled = rescheduleCount > 0;

  // Pro trust details — photo, rating, jobs done — once a Pro has accepted.
  // Builds confidence before a stranger arrives. First name + these only; no PII.
  let proPhoto = null, proRating = null, proJobs = null, proVerified = false;
  if (booking.assembler_accepted_at && booking.assembler_id) {
    try {
      const { data: pro } = await sb
        .from('profiles')
        .select('profile_photo, rating, completed_jobs, identity_verified')
        .eq('id', booking.assembler_id)
        .maybeSingle();
      if (pro) {
        proPhoto  = pro.profile_photo || null;
        proRating = (pro.rating != null && pro.rating > 0) ? Number(pro.rating) : null;
        proJobs   = (pro.completed_jobs != null) ? Number(pro.completed_jobs) : null;
        proVerified = pro.identity_verified === true;
      }
    } catch (e) { /* non-fatal */ }
  }

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
    tax_amount: booking.tax_amount || 0,
    service_call_fee: booking.service_call_fee || 0,
    amount_charged: booking.amount_charged || null,
    refund_amount: booking.refund_amount || 0,
    deposit_amount: booking.deposit_amount || null,
    payment_status: booking.payment_status || null,
    owner_manual_payment: booking.source === 'owner_manual',
    gross_payment_cents: grossPaymentCents,
    amount_collected_cents: amountCollectedCents,
    remaining_balance_cents: remainingBalanceCents,
    return_visit_required: booking.return_visit_required === true,
    return_visit_date: booking.return_visit_required ? booking.return_visit_date || null : null,
    return_visit_time: booking.return_visit_required ? booking.return_visit_time || null : null,
    work_completed: booking.return_visit_required ? booking.return_visit_completed_scope || null : null,
    work_remaining: booking.return_visit_required ? booking.return_visit_remaining_scope || null : null,
    created_at: booking.created_at,
    cancelled_at: booking.cancelled_at || null,
    completed_at: booking.completed_at || null,
    cancel_reason: booking.cancel_reason || null,
    cancellation_fee: booking.cancellation_fee || null,
    was_rescheduled: wasRescheduled,
    // Pro trust signal — first name only (never full name/phone to customer),
    // shown once the Pro has accepted the job.
    pro_first_name: (booking.assembler_accepted_at && booking.assembler_name)
      ? booking.assembler_name.split(' ')[0]
      : null,
    pro_verified: proVerified,
    pro_photo: proPhoto,
    pro_rating: proRating,
    pro_jobs: proJobs,
  };

  return res.status(200).json({ booking: safe });
}
