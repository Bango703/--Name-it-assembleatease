import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from './_activity.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';

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
    .select('id, ref, status, assembler_id, dispatch_paused, needs_manual_dispatch, service, customer_name')
    .eq('id', bookingId)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    return res.status(400).json({ error: `Only confirmed bookings can be dispatched (current: ${booking.status})` });
  }
  if (booking.assembler_id) {
    return res.status(400).json({ error: 'Booking is already assigned to an Easer' });
  }

  // If force=true, temporarily clear pause/manual flags before dispatching
  if (force) {
    await sb.from('bookings')
      .update({
        dispatch_paused: false,
        needs_manual_dispatch: false,
        dispatch_status: null,
        dispatch_attempt: 0,
      })
      .eq('id', bookingId);
  }

  // Cancel any stale open offers so the engine can send a fresh batch
  if (force) {
    await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
  }

  // Delegate to the shared engine
  const result = await dispatchBooking(bookingId);

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
