import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';
import { canRecoverPaymentNow } from './_pending-payment-recovery.js';
import { customerBookingAccess, usesCustomerAccount } from './_customer-access.js';
import { loadCustomerFacingCompletionPhoto } from './_completion-evidence.js';
import { evaluateCancellationPolicy } from './_cancellation-policy-truth.js';
import { cancellationPreview } from './_cancellation-fee-summary.js';
import { customerMessageRecipient } from './_message-routing.js';
import { loadOpenProposal } from './_time-proposals.js';
import { customerStatusLabel } from './_customer-status.js';
import { customerPaymentSummary } from './_customer-payment-summary.js';
import { loadBookingItems } from './_booking-items.js';
import { TIME_SLOTS, MAX_RESCHEDULES, RESCHEDULABLE_STATUSES } from './reschedule.js';
import { BOOKING_WINDOW_DAYS } from './_booking-window.js';

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
  const viaAccount = usesCustomerAccount(req, { token });
  if (!ref || (!viaAccount && (!email || !token))) {
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
  if (!booking || !(await customerBookingAccess(sb, req, booking, { email, token })).ok) {
    return res.status(404).json({
      error: 'This secure booking link is invalid or expired. Request a new link and try again.',
    });
  }

  const customerStatus = customerStatusLabel(booking);

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
    // Refunds reduce net retained revenue but do not silently create a new
    // customer invoice. Gross verified payments determine what remains due.
    const amountPaidTowardInvoice = (paymentEvents || []).length ? ledgerGross : amountCollectedCents;
    remainingBalanceCents = Math.max(0, Number(booking.total_price || 0) - amountPaidTowardInvoice);
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

  // The cancel button's fee warning. Worked out by the same evaluation the
  // cancel endpoints charge with, so what the customer is shown is what they
  // are charged, for the same reason. The page renders this; it never
  // computes a fee of its own.
  let cancellationPreviewPayload = null;
  if (!['cancelled', 'completed', 'declined', 'refunded'].includes(String(booking.status || '').toLowerCase())) {
    try {
      cancellationPreviewPayload = cancellationPreview(evaluateCancellationPolicy(booking).policy);
    } catch (previewError) {
      console.error('Cancellation preview unavailable:', previewError.message);
    }
  }

  // Pro trust details — photo, rating, jobs done — once a Pro has accepted.
  // Builds confidence before a stranger arrives. First name + these only; no PII.
  let proPhoto = null, proRating = null, proJobs = null, proVerified = false, proTier = null;
  if (booking.assembler_accepted_at && booking.assembler_id) {
    try {
      const { data: pro } = await sb
        .from('profiles')
        .select('profile_photo, rating, completed_jobs, identity_verified, tier')
        .eq('id', booking.assembler_id)
        .maybeSingle();
      if (pro) {
        proPhoto  = pro.profile_photo || null;
        proRating = (pro.rating != null && pro.rating > 0) ? Number(pro.rating) : null;
        proJobs   = (pro.completed_jobs != null) ? Number(pro.completed_jobs) : null;
        proVerified = pro.identity_verified === true;
        // Customer-facing tier badge — only the earned status tiers, never 'starter'
        // (absence of a badge is neutral; a badge is a positive signal only).
        proTier = (pro.tier === 'elite' || pro.tier === 'professional') ? pro.tier : null;
      }
    } catch (e) { /* non-fatal */ }
  }

  // Completion photo — shown to the customer ONLY when a photo has been
  // deliberately promoted to customer-facing. An Easer upload is internal
  // the job is done (on the review page and the tracking page). Signed URL, 7-day
  // expiry; only generated for completed jobs so normal lookups stay cheap.
  let completionPhotoUrl = null;
  if (booking.status === BOOKING_STATUS.COMPLETED) {
    try {
      const { evidence } = await loadCustomerFacingCompletionPhoto(sb, booking, { allowHistoricalOwnerManual: true });
      if (evidence?.storage_path) {
        const { data: signed } = await sb.storage
          .from('booking-evidence')
          .createSignedUrl(evidence.storage_path, 60 * 60 * 24 * 7);
        completionPhotoUrl = signed?.signedUrl || null;
      }
    } catch (e) { /* non-fatal — photo is a bonus, never blocks tracking */ }
  }

  // Return only safe/public fields — never expose Stripe IDs, phone, raw payment data
  // A new time the assigned pro proposed, for the customer to accept or decline
  // here (api/booking/time-proposal.js; accepting goes through reschedule).
  const openProposal = booking.assembler_id && booking.assembler_accepted_at && booking.status === BOOKING_STATUS.CONFIRMED
    ? await loadOpenProposal(sb, booking.id)
    : null;
  const easerTimeProposal = openProposal && openProposal.easer_id === booking.assembler_id
    ? { id: openProposal.id, date: openProposal.proposed_date, time: openProposal.proposed_time, note: openProposal.note || null }
    : null;

  // What was booked, with the customer's own prices (same loader as owner and
  // Easer). A failed read shows no list rather than blocking the booking.
  let items = [];
  try {
    items = (await loadBookingItems(booking.id, { sb, includePricing: true })).get(booking.id) || [];
  } catch (itemsError) {
    console.error('Track booking items unavailable:', itemsError?.message || itemsError);
  }

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
    // A failed card should not be findable only through an email the customer
    // may have lost. Same predicate the secure page gates on, so the button
    // can never appear for a booking that page would refuse. No new access:
    // the link carries the guest token this request already proved.
    payment_action_required: canRecoverPaymentNow(booking),
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
    cancellation_preview: cancellationPreviewPayload,
    // Who the message box delivers to; same rule the message API routes with.
    message_recipient: customerMessageRecipient(booking) === 'assembler' ? 'pro' : 'team',
    // Pro trust signal — first name only (never full name/phone to customer),
    // shown once the Pro has accepted the job.
    pro_first_name: (booking.assembler_accepted_at && booking.assembler_name)
      ? booking.assembler_name.split(' ')[0]
      : null,
    pro_verified: proVerified,
    pro_photo: proPhoto,
    pro_rating: proRating,
    pro_jobs: proJobs,
    pro_tier: proTier,
    completion_photo_url: completionPhotoUrl,
    easer_time_proposal: easerTimeProposal,
    items,
    // The times a reschedule may choose, from the rule reschedule.js enforces.
    reschedule_options: { slots: TIME_SLOTS, window_days: BOOKING_WINDOW_DAYS },
    // The same gates api/booking/reschedule.js applies first (status, then the limit).
    can_reschedule: RESCHEDULABLE_STATUSES.includes(booking.status) && rescheduleCount < MAX_RESCHEDULES,
  };
  // The price breakdown, worked out once here for the page and the app.
  safe.payment_summary = customerPaymentSummary(safe);

  return res.status(200).json({ booking: safe });
}
