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
  const results = { expired: 0, retried: [], renewed: [], paymentHeld: [], flagged: [], errors: [] };

  // KEEP OFFERS OPEN WHEN THERE IS NOBODY ELSE TO ASK.
  //
  // The retry ladder is right when there are more Easers: an unanswered offer
  // expires and the job widens to the next batch. But once every eligible Easer
  // already has it, expiring achieves nothing — the job leaves their queue,
  // lands back on the owner as "needs manual dispatch", and the only people who
  // could ever take it can no longer see it. On a small roster that is the
  // normal case, not the edge case.
  //
  // When enabled, the offer is RENEWED instead: it stays live in the Easer's app
  // until someone accepts, declines, or the owner intervenes. Declined offers
  // are never renewed — a no is a no. The owner still sees the booking as
  // awaiting acceptance through the existing Live Ops alerts, so nothing goes
  // quiet; it simply stops being handed back with nowhere to go.
  const KEEP_OFFERS_OPEN = String(process.env.DISPATCH_KEEP_OFFERS_OPEN || 'true').toLowerCase() !== 'false';
  const RENEW_MINUTES = parseInt(process.env.DISPATCH_OFFER_TTL_MINUTES || '20', 10);

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
          // Exhausted the roster rather than hit a fault: everyone eligible already
          // has this job. Hand it back to nobody — keep it live with the Easers who
          // can actually take it.
          const rosterExhausted = /already received offers|No available Easers|No eligible Easers/i
            .test(retry?.message || '');
          let renewed = 0;
          if (KEEP_OFFERS_OPEN && rosterExhausted) {
            const renewedUntil = new Date(Date.now() + RENEW_MINUTES * 60 * 1000).toISOString();
            const { data: renewedRows, error: renewErr } = await sb
              .from('dispatch_offers')
              .update({ offer_status: 'sent', expires_at: renewedUntil, timed_out_at: null })
              .eq('booking_id', bookingId)
              // Only offers this sweep just expired. A DECLINED offer is never
              // revived, and an accepted/superseded one must never be reopened.
              .eq('offer_status', 'expired')
              .select('id');
            if (renewErr) {
              console.error('expire-offers: renew failed', bookingId, renewErr.message);
            } else {
              renewed = (renewedRows || []).length;
            }
          }

          if (renewed > 0) {
            results.renewed.push({ bookingId, ref: booking.ref, offers: renewed, reason: retry?.message });
            console.log(`expire-offers: kept ${renewed} offer(s) open on ${booking.ref} — no other Easer to try`);
            // Deliberately NOT re-notified. This cron runs every 10 minutes; a
            // fresh email each pass would be harassment, and the job is already
            // sitting in their app. Renewal keeps it visible, it does not re-ping.
            finalization = { action: 'kept_open', ref: booking.ref, attempt: finalization.attempt };
          } else {
            finalization = await finalizeDispatchRound(sb, {
              bookingId,
              maxAttempts: MAX_ATTEMPTS,
              forceManual: true,
            });
          }
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
