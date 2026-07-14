import { getSupabase } from '../_supabase.js';
import { finalizeDispatchRound, holdDispatchForPaymentReconciliation, notifyOwnerManualDispatch } from '../booking/_dispatch-safety.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { logCron } from './_cron-logger.js';

const MAX_ATTEMPTS = parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10);

/**
 * GET /api/cron/expire-offers
 * Runs every 10 minutes via Vercel cron.
 * 1. Expires stale 'sent' offers past their expiry time.
 * 2. For bookings where ALL offers are now resolved (expired/declined):
 *    - If under max attempts: trigger next dispatch round
 *    - If at max attempts: flag needs_manual_dispatch, alert owner
 */
export default async function handler(req, res) {
  const secret = req.headers['authorization']?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  const now = new Date().toISOString();
  const results = { expired: 0, retried: [], paymentHeld: [], flagged: [], errors: [] };

  // ── Step 1: Expire stale offers ────────────────────────────────────────────
  const { data: expiredOffers, error: expireErr } = await sb
    .from('dispatch_offers')
    .update({ offer_status: 'expired', timed_out_at: now })
    .eq('offer_status', 'sent')
    .lt('expires_at', now)
    .select('id, booking_id');

  if (expireErr) {
    console.error('expire-offers: expire error', expireErr);
    results.errors.push('expire step: ' + expireErr.message);
  } else {
    results.expired = (expiredOffers || []).length;
  }

  // ── Step 2: Find bookings whose round may now be resolved ──────────────────
  // Include the normal just-expired set plus a bounded recovery sweep of
  // confirmed/unassigned offered or dropped bookings. The sweep repairs a
  // request that stopped after resolving/releasing a job but before rematching.
  const { data: recoveryBookings, error: recoveryError } = await sb
    .from('bookings')
    .select('id')
    .eq('status', 'confirmed')
    .is('assembler_id', null)
    .in('dispatch_status', ['offered', 'dropped'])
    .or('dispatch_paused.is.null,dispatch_paused.eq.false')
    .or('needs_manual_dispatch.is.null,needs_manual_dispatch.eq.false');

  if (recoveryError) {
    console.error('expire-offers: recovery lookup error', recoveryError);
    results.errors.push('recovery lookup: ' + recoveryError.message);
  }

  const affectedBookingIds = [...new Set([
    ...(expiredOffers || []).map(o => o.booking_id),
    ...(recoveryBookings || []).map(b => b.id),
  ])];
  if (!affectedBookingIds.length) {
    console.log('expire-offers: no affected bookings', { expired: results.expired });
    return res.status(200).json({ ok: true, ...results });
  }

  for (const bookingId of affectedBookingIds) {
    try {
      // Fetch context for owner-visible logging. The row-locked RPC below is
      // the source of truth for whether this round retries or needs an owner.
      const { data: booking, error: bookingError } = await sb
        .from('bookings')
        .select('id, ref, service, customer_name, dispatch_attempt, assembler_id, status, dispatch_paused, needs_manual_dispatch')
        .eq('id', bookingId)
        .single();

      if (bookingError || !booking) {
        throw bookingError || new Error('Booking not found');
      }

      let finalization = await finalizeDispatchRound(sb, {
        bookingId,
        maxAttempts: MAX_ATTEMPTS,
      });

      if (finalization.action === 'retry') {
        const retry = await dispatchBooking(bookingId);
        results.retried.push({
          bookingId,
          ref: booking.ref,
          attempt: finalization.attempt + 1,
          result: retry.message,
          dispatched: retry.dispatched || 0,
        });
        console.log(`expire-offers: retry dispatch ${booking.ref} attempt ${finalization.attempt + 1}`, retry);

        if (retry?.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          await holdDispatchForPaymentReconciliation(sb, {
            booking,
            source: 'expire-offers',
            detail: retry.message,
          });
          results.paymentHeld.push({ bookingId, ref: booking.ref });
          finalization = { action: 'payment_hold', ref: booking.ref, attempt: finalization.attempt };
        }

        // No candidates, an insert conflict, or another safe dispatch failure
        // must produce explicit owner action rather than an idle booking.
        if (!retry?.dispatched && retry?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED') {
          finalization = await finalizeDispatchRound(sb, {
            bookingId,
            maxAttempts: MAX_ATTEMPTS,
            forceManual: true,
          });
        }
      }

      if (finalization.action === 'manual_required') {
        results.flagged.push({ bookingId, ref: booking.ref, attempts: finalization.attempt });
        await notifyOwnerManualDispatch(sb, {
          booking,
          source: 'expire-offers',
          reason: `All offers expired or were resolved after ${finalization.attempt} dispatch attempt(s).`,
          metadata: { attempt: finalization.attempt },
        });
        console.log(`expire-offers: flagged ${booking.ref} for manual dispatch after ${finalization.attempt} attempts`);
      }
    } catch (err) {
      console.error('expire-offers: error processing booking', bookingId, err.message);
      results.errors.push(`${bookingId}: ${err.message}`);
    }
  }

  console.log('expire-offers complete:', results);
  await logCron('expire-offers', {
    records: results.expired + results.retried.length + results.flagged.length,
    status: results.errors.length ? 'partial' : 'ok',
    error: results.errors.length ? results.errors.join('; ') : null,
  });
  return res.status(200).json({ ok: true, ...results });
}
