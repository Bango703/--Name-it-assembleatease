import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';

/**
 * POST /api/booking/dispatch-control
 * Owner controls for dispatch state on a booking.
 * Body: { bookingId, action }
 *
 * Actions:
 *   pause        — stop auto-dispatch cron from touching this booking
 *   unpause      — resume auto-dispatch for this booking
 *   retry        — clear failed state and dispatch immediately
 *   cancel       — cancel all open offers, reset dispatch state
 *   mark_manual  — flag as needs_manual_dispatch (same as max attempts reached)
 *   dry_run      — return scoring preview without sending notifications
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, action } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  if (!action) return res.status(400).json({ error: 'action is required' });

  const sb = getSupabase();
  const now = new Date().toISOString();

  const { data: booking } = await sb
    .from('bookings')
    .select('id, ref, status, payment_status, total_price, deposit_amount, stripe_payment_intent_id, stripe_deposit_intent_id, confirmed_by, assembler_id, dispatch_attempt, dispatch_paused, needs_manual_dispatch, financial_operation_key, financial_operation_type, financial_operation_started_at, stripe_dispute_id, stripe_dispute_status')
    .eq('id', bookingId)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({
      error: 'A financial action is already in progress for this booking. Dispatch controls remain blocked until it finishes.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  async function updateDispatchState(payload) {
    let updateQuery = sb.from('bookings')
      .update(payload)
      .eq('id', bookingId)
      .eq('status', booking.status)
      .eq('payment_status', booking.payment_status)
      .is('financial_operation_key', null)
      .is('financial_operation_type', null)
      .is('financial_operation_started_at', null);
    updateQuery = booking.assembler_id == null
      ? updateQuery.is('assembler_id', null)
      : updateQuery.eq('assembler_id', booking.assembler_id);
    const { data, error } = await updateQuery.select('id');
    if (error || !data?.length) {
      return { ok: false, error, status: error ? 503 : 409 };
    }
    return { ok: true };
  }

  const dispatchStateChanged = (result) => res.status(result.status).json({
    error: 'Booking, assignment, or payment state changed before dispatch controls could be updated. Refresh before retrying.',
    code: 'DISPATCH_STATE_CHANGED',
  });

  const paymentHoldResponse = () => res.status(409).json({
    error: 'Payment is not verified for dispatch. Reconcile Stripe before resuming or sending offers.',
    code: 'DISPATCH_PAYMENT_NOT_VERIFIED',
  });

  // ── PAUSE ─────────────────────────────────────────────────────────────────
  if (action === 'pause') {
    const updateResult = await updateDispatchState({ dispatch_paused: true });
    if (!updateResult.ok) return dispatchStateChanged(updateResult);
    logActivity(sb, {
      bookingId,
      eventType: 'dispatch_paused',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Auto-dispatch paused by owner',
      metadata: { at: now },
    });
    return res.status(200).json({ ok: true, action: 'paused', message: 'Auto-dispatch paused for this booking.' });
  }

  // ── UNPAUSE ───────────────────────────────────────────────────────────────
  if (action === 'unpause') {
    if (!isBookingPaymentReadyForDispatch(booking)) return paymentHoldResponse();
    const updateResult = await updateDispatchState({ dispatch_paused: false });
    if (!updateResult.ok) return dispatchStateChanged(updateResult);
    logActivity(sb, {
      bookingId,
      eventType: 'dispatch_unpaused',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Auto-dispatch resumed by owner',
      metadata: { at: now },
    });
    return res.status(200).json({ ok: true, action: 'unpaused', message: 'Auto-dispatch resumed.' });
  }

  // ── MARK MANUAL ───────────────────────────────────────────────────────────
  if (action === 'mark_manual') {
    const updateResult = await updateDispatchState({ needs_manual_dispatch: true, dispatch_paused: true });
    if (!updateResult.ok) return dispatchStateChanged(updateResult);
    logActivity(sb, {
      bookingId,
      eventType: 'dispatch_marked_manual',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Booking flagged for manual dispatch',
      metadata: { at: now },
    });
    return res.status(200).json({ ok: true, action: 'marked_manual', message: 'Booking flagged for manual assignment.' });
  }

  // ── CANCEL OPEN OFFERS ────────────────────────────────────────────────────
  if (action === 'cancel') {
    const updateResult = await updateDispatchState({
      dispatch_status: null,
      dispatch_attempt: 0,
      needs_manual_dispatch: false,
    });
    if (!updateResult.ok) return dispatchStateChanged(updateResult);

    const { error } = await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);

    if (error) return res.status(500).json({ error: 'Failed to cancel offers' });
    logActivity(sb, {
      bookingId,
      eventType: 'dispatch_cancelled',
      actorType: 'owner',
      actorName: 'Owner',
      description: 'Owner cancelled all open dispatch offers and reset dispatch state',
      metadata: { at: now },
    });
    return res.status(200).json({ ok: true, action: 'cancelled', message: 'All open offers cancelled. Dispatch state reset.' });
  }

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  if (action === 'dry_run') {
    if (!isBookingPaymentReadyForDispatch(booking)) return paymentHoldResponse();
    const result = await dispatchBooking(bookingId, { dryRun: true });
    if (result.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') return paymentHoldResponse();
    return res.status(200).json({ ok: true, action: 'dry_run', ...result });
  }

  // ── RETRY (clear + dispatch immediately) ─────────────────────────────────
  if (action === 'retry') {
    if (booking.assembler_id) {
      return res.status(400).json({ error: 'Booking already assigned. Use the assign endpoint to reassign.' });
    }
    if (booking.status !== BOOKING_STATUS.CONFIRMED) {
      return res.status(400).json({ error: `Booking is not confirmed (status: ${booking.status})` });
    }
    if (!isBookingPaymentReadyForDispatch(booking)) return paymentHoldResponse();

    // Cancel any open offers first
    // Reset dispatch state so the engine can re-run
    let retryQuery = sb.from('bookings').update({
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
    retryQuery = booking.total_price == null ? retryQuery.is('total_price', null) : retryQuery.eq('total_price', booking.total_price);
    retryQuery = booking.stripe_payment_intent_id == null
      ? retryQuery.is('stripe_payment_intent_id', null)
      : retryQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
    retryQuery = booking.stripe_deposit_intent_id == null
      ? retryQuery.is('stripe_deposit_intent_id', null)
      : retryQuery.eq('stripe_deposit_intent_id', booking.stripe_deposit_intent_id);
    const { data: retryRows, error: retryStateError } = await retryQuery.select('id');
    if (retryStateError || !retryRows?.length) {
      return res.status(retryStateError ? 503 : 409).json({
        error: 'Booking or payment state changed before dispatch retry. Refresh and reconcile before retrying.',
        code: 'DISPATCH_STATE_CHANGED',
      });
    }

    const { error: retryOfferError } = await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
    if (retryOfferError) return res.status(503).json({ error: 'Existing offers could not be safely reset. No new offers were sent.' });

    // Trigger immediate dispatch
    const result = await dispatchBooking(bookingId);
    if (result.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') return paymentHoldResponse();
    console.log(`dispatch-control: retry for ${booking.ref}`, result);

    logActivity(sb, {
      bookingId,
      eventType: 'dispatch_retried',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Owner retried dispatch: ${result.message}`,
      metadata: {
        dispatched: result.dispatched,
        attempt: result.attemptNumber,
        offeredTo: result.offeredTo,
        expiresAt: result.expiresAt,
      },
    });

    return res.status(200).json({
      ok: true,
      action: 'retried',
      dispatched: result.dispatched,
      message: result.message,
      offeredTo: result.offeredTo,
      expiresAt: result.expiresAt,
    });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}
