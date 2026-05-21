import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';

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
    .select('id, ref, status, assembler_id, dispatch_attempt, dispatch_paused, needs_manual_dispatch')
    .eq('id', bookingId)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // ── PAUSE ─────────────────────────────────────────────────────────────────
  if (action === 'pause') {
    await sb.from('bookings').update({ dispatch_paused: true }).eq('id', bookingId);
    return res.status(200).json({ ok: true, action: 'paused', message: 'Auto-dispatch paused for this booking.' });
  }

  // ── UNPAUSE ───────────────────────────────────────────────────────────────
  if (action === 'unpause') {
    await sb.from('bookings').update({ dispatch_paused: false }).eq('id', bookingId);
    return res.status(200).json({ ok: true, action: 'unpaused', message: 'Auto-dispatch resumed.' });
  }

  // ── MARK MANUAL ───────────────────────────────────────────────────────────
  if (action === 'mark_manual') {
    await sb.from('bookings').update({ needs_manual_dispatch: true, dispatch_paused: true }).eq('id', bookingId);
    return res.status(200).json({ ok: true, action: 'marked_manual', message: 'Booking flagged for manual assignment.' });
  }

  // ── CANCEL OPEN OFFERS ────────────────────────────────────────────────────
  if (action === 'cancel') {
    const { error } = await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('booking_id', bookingId)
      .eq('offer_status', 'sent');

    await sb.from('bookings').update({
      dispatch_status: null,
      dispatch_attempt: 0,
      needs_manual_dispatch: false,
    }).eq('id', bookingId);

    if (error) return res.status(500).json({ error: 'Failed to cancel offers' });
    return res.status(200).json({ ok: true, action: 'cancelled', message: 'All open offers cancelled. Dispatch state reset.' });
  }

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  if (action === 'dry_run') {
    const result = await dispatchBooking(bookingId, { dryRun: true });
    return res.status(200).json({ ok: true, action: 'dry_run', ...result });
  }

  // ── RETRY (clear + dispatch immediately) ─────────────────────────────────
  if (action === 'retry') {
    if (booking.assembler_id) {
      return res.status(400).json({ error: 'Booking already assigned. Use the assign endpoint to reassign.' });
    }
    if (booking.status !== 'confirmed') {
      return res.status(400).json({ error: `Booking is not confirmed (status: ${booking.status})` });
    }

    // Cancel any open offers first
    await sb.from('dispatch_offers')
      .update({ offer_status: 'cancelled' })
      .eq('booking_id', bookingId)
      .eq('offer_status', 'sent');

    // Reset dispatch state so the engine can re-run
    await sb.from('bookings').update({
      dispatch_paused: false,
      needs_manual_dispatch: false,
      dispatch_status: null,
    }).eq('id', bookingId);

    // Trigger immediate dispatch
    const result = await dispatchBooking(bookingId);
    console.log(`dispatch-control: retry for ${booking.ref}`, result);

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
