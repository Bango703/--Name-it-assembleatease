import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from './_activity.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';

/**
 * POST /api/booking/dispatch
 * Owner-triggered: dispatch a confirmed booking to the best available Easers.
 * Now delegates entirely to _dispatch-internal.js for consistency with the
 * auto-dispatch cron and expire-offers retry logic.
 *
 * Body: { bookingId, force? }
 *   force=true — bypass pause/manual flags and dispatch immediately
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, force } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId required' });

  const sb = getSupabase();

  // Basic booking validation before delegating
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, ref, status, payment_status, total_price, deposit_amount, stripe_payment_intent_id, stripe_deposit_intent_id, confirmed_by, assembler_id, dispatch_paused, needs_manual_dispatch, service, customer_name, financial_operation_key, financial_operation_type, financial_operation_started_at, stripe_dispute_id, stripe_dispute_status')
    .eq('id', bookingId)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({
      error: 'A financial action is already in progress for this booking. Dispatch remains blocked until it finishes.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    return res.status(400).json({ error: `Only confirmed bookings can be dispatched (current: ${booking.status})` });
  }
  if (booking.assembler_id) {
    return res.status(400).json({ error: 'Booking is already assigned to an Easer' });
  }
  if (!isBookingPaymentReadyForDispatch(booking)) {
    return res.status(409).json({
      error: 'Payment is not verified for dispatch. Reconcile Stripe before sending offers.',
      code: 'DISPATCH_PAYMENT_NOT_VERIFIED',
    });
  }

  // If force=true, temporarily clear pause/manual flags before dispatching
  if (force) {
    let forceQuery = sb.from('bookings')
      .update({
        dispatch_paused: false,
        needs_manual_dispatch: false,
        dispatch_status: null,
        dispatch_attempt: 0,
      })
      .eq('id', bookingId)
      .eq('status', BOOKING_STATUS.CONFIRMED)
      .eq('payment_status', booking.payment_status)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null)
      .is('assembler_id', null);
    forceQuery = booking.total_price == null ? forceQuery.is('total_price', null) : forceQuery.eq('total_price', booking.total_price);
    forceQuery = booking.stripe_payment_intent_id == null
      ? forceQuery.is('stripe_payment_intent_id', null)
      : forceQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
    forceQuery = booking.stripe_deposit_intent_id == null
      ? forceQuery.is('stripe_deposit_intent_id', null)
      : forceQuery.eq('stripe_deposit_intent_id', booking.stripe_deposit_intent_id);
    const { data: forceRows, error: forceError } = await forceQuery.select('id');
    if (forceError || !forceRows?.length) {
      return res.status(forceError ? 503 : 409).json({
        error: 'Booking or payment state changed before forced dispatch. Refresh and reconcile before retrying.',
        code: 'DISPATCH_STATE_CHANGED',
      });
    }
  }

  // Cancel any stale open offers so the engine can send a fresh batch
  if (force) {
    const { error: cancelOfferError } = await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
    if (cancelOfferError) return res.status(503).json({ error: 'Existing offers could not be safely reset. No new offers were sent.' });
  }

  // Delegate to the shared engine
  const result = await dispatchBooking(bookingId);
  if (result.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') {
    return res.status(409).json({ error: result.message, code: result.code });
  }

  if (result.dispatched > 0 || result.dryRun) {
    const names = (result.offeredTo || []).map(e => e.name).join(', ');
    logActivity(sb, {
      bookingId,
      eventType: 'dispatched',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Dispatch attempt ${result.attemptNumber || '?'} — offered to ${result.dispatched} Easer(s): ${names}`,
      metadata: { dispatched: result.dispatched, attempt: result.attemptNumber, offeredTo: result.offeredTo },
    });
  }

  return res.status(200).json({
    dispatched: result.dispatched,
    message:    result.message,
    offeredTo:  result.offeredTo || [],
    expiresAt:  result.expiresAt,
    attemptNumber: result.attemptNumber,
  });
}
