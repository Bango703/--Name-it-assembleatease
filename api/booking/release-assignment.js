import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { logActivity } from './_activity.js';
import { BOOKING_STATUS } from '../_source-of-truth.js';

/**
 * POST /api/booking/release-assignment — owner only.
 *
 * Takes a job back off an Easer who has NOT accepted it, returning the booking
 * to unassigned so it can be dispatched or handed to someone else immediately.
 *
 * Why this exists: an assignment that is sitting unaccepted used to hold up the
 * whole job. Reassign required picking a specific replacement on the spot, and
 * there was no way to simply free the booking. An unaccepted assignment is not a
 * commitment from anyone — it must never be able to block operations.
 *
 * Deliberately narrow and money-neutral:
 *   - Only while the Easer has NOT accepted. Once accepted, or once the job is
 *     underway, the existing Reassign / Owner Override paths own it, because
 *     those carry earnings and customer-facing consequences.
 *   - Touches assignment fields only. No status change, no payment, no payout,
 *     no cancellation. The customer's booking and card authorization are
 *     untouched — from the customer's side nothing happened.
 *   - Compare-and-set on the exact Easer and assigned_at, so a release cannot
 *     race an acceptance that lands at the same moment.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { bookingId, reason } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error: bErr } = await sb
    .from('bookings')
    .select('id, ref, service, date, time, status, assembler_id, assembler_name, assigned_at, assembler_accepted_at, dispatch_status, financial_operation_key, financial_operation_type, financial_operation_started_at')
    .eq('id', bookingId)
    .single();
  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (!booking.assembler_id) {
    return res.status(200).json({ ok: true, alreadyUnassigned: true, message: 'This booking has no Easer assigned.' });
  }
  if (booking.assembler_accepted_at || booking.dispatch_status === 'accepted') {
    return res.status(409).json({
      error: 'This Easer has already accepted the job. Use Reassign to hand it to someone else so the change is recorded against their acceptance.',
      code: 'ALREADY_ACCEPTED',
    });
  }
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    return res.status(409).json({
      error: `A ${booking.status} booking cannot be released. Only a confirmed, not-yet-accepted assignment can be handed back.`,
      code: 'STATUS_NOT_RELEASABLE',
    });
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({
      error: 'A payment, cancellation, or payout operation is in progress. Wait for it to finish before changing the Easer.',
      code: 'BOOKING_FINANCIAL_OPERATION_IN_PROGRESS',
    });
  }

  const previousEaserId = booking.assembler_id;
  const previousEaserName = booking.assembler_name || 'the assigned Easer';

  // Compare-and-set against the exact assignment we just read. If the Easer
  // accepts in this window the guard fails and nothing is released.
  let releaseQuery = sb
    .from('bookings')
    .update({
      assembler_id: null,
      assembler_name: null,
      assigned_at: null,
      assembler_accepted_at: null,
      dispatch_status: null,
      // MUST clear the pause. api/booking/assign.js sets dispatch_paused = true
      // when an Easer is assigned, so auto-dispatch does not compete for a job
      // that already has someone. Clearing assembler_id without clearing this
      // left the booking unassigned AND paused: Smart Dispatch then refused with
      // "Dispatch is paused on this booking" — a pause the owner never set and
      // could not see. Releasing a job means it is dispatchable again.
      dispatch_paused: false,
      needs_manual_dispatch: false,
    })
    .eq('id', booking.id)
    .eq('assembler_id', previousEaserId)
    .eq('status', BOOKING_STATUS.CONFIRMED)
    .is('assembler_accepted_at', null);
  releaseQuery = booking.assigned_at == null
    ? releaseQuery.is('assigned_at', null)
    : releaseQuery.eq('assigned_at', booking.assigned_at);

  const { data: released, error: releaseErr } = await releaseQuery.select('id');
  if (releaseErr) {
    console.error('Release assignment error:', releaseErr);
    return res.status(500).json({ error: 'Could not release the assignment. Nothing was changed.' });
  }
  if (!released?.length) {
    return res.status(409).json({
      error: 'The assignment changed while releasing it — the Easer may have just accepted. Refresh and check before trying again.',
      code: 'RELEASE_STATE_CHANGED',
    });
  }

  await logActivity(sb, {
    bookingId: booking.id,
    eventType: 'assignment_released',
    actor: 'owner',
    description: `Assignment released from ${previousEaserName} before acceptance`
      + (reason ? ` — ${String(reason).slice(0, 300)}` : ''),
  }).catch(() => {});

  // NO notification is sent. Release only ever applies to an Easer who has NOT
  // accepted, so there is no commitment to withdraw and nothing to apologise for
  // — telling someone a job they never took is 'no longer theirs' is noise about
  // a thing that never happened. This also matches how the platform already
  // behaves: an unaccepted dispatch offer that expires notifies nobody either.
  // The job simply leaves their queue. An Easer who HAS accepted cannot be
  // released at all (guarded above) — that path is Reassign, which does notify.

  return res.status(200).json({
    ok: true,
    released: true,
    previousEaserName,
    message: `Released from ${previousEaserName}. The booking is unassigned and ready to dispatch or assign.`,
  });
}
