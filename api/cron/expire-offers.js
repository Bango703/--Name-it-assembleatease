import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { logCron } from './_cron-logger.js';

const MAX_ATTEMPTS = parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10);
const SITE = 'https://www.assembleatease.com';

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
  const results = { expired: 0, retried: [], flagged: [], errors: [] };

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

  // ── Step 2: Find bookings with no remaining open offers ────────────────────
  // Get unique booking_ids from just-expired offers
  const affectedBookingIds = [...new Set((expiredOffers || []).map(o => o.booking_id))];
  if (!affectedBookingIds.length) {
    console.log('expire-offers: no affected bookings', { expired: results.expired });
    return res.status(200).json({ ok: true, ...results });
  }

  for (const bookingId of affectedBookingIds) {
    try {
      // Check if any offers are still open for this booking
      const { data: openOffers } = await sb
        .from('dispatch_offers')
        .select('id')
        .eq('booking_id', bookingId)
        .eq('offer_status', 'sent');

      if ((openOffers || []).length > 0) continue; // still has open offers

      // Fetch booking to check attempt count and current state
      const { data: booking } = await sb
        .from('bookings')
        .select('id, ref, service, customer_name, dispatch_attempt, assembler_id, status, dispatch_paused, needs_manual_dispatch')
        .eq('id', bookingId)
        .single();

      if (!booking) continue;
      if (booking.assembler_id) continue; // already assigned
      if (booking.status !== 'confirmed') continue;
      if (booking.dispatch_paused) continue;
      if (booking.needs_manual_dispatch) continue;

      const attempt = booking.dispatch_attempt || 0;

      if (attempt < MAX_ATTEMPTS) {
        // Retry dispatch
        const result = await dispatchBooking(bookingId);
        results.retried.push({ bookingId, ref: booking.ref, attempt: attempt + 1, result: result.message });
        console.log(`expire-offers: retry dispatch ${booking.ref} attempt ${attempt + 1}`, result);
      } else {
        // Max attempts reached — flag for manual dispatch and alert owner
        await sb.from('bookings')
          .update({ needs_manual_dispatch: true })
          .eq('id', bookingId);

        results.flagged.push({ bookingId, ref: booking.ref, attempts: attempt });

        sendEmail({
          to:      ownerEmail(),
          from:    'AssembleAtEase <booking@assembleatease.com>',
          subject: `Dispatch Failed — ${esc(booking.ref)} needs manual assignment`,
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h2 style="color:#dc2626">Job Needs Manual Assignment</h2>
            <p><strong>${esc(booking.ref)}</strong> — ${esc(booking.service)} for ${esc(booking.customer_name)}</p>
            <p>Auto-dispatch attempted <strong>${attempt} time(s)</strong> with no Easer accepting. No eligible Easers available or all declined.</p>
            <p>This booking has been flagged as <strong>Needs Manual Dispatch</strong>.</p>
            <p><a href="${SITE}/owner/#bookings" style="color:#00BFFF;font-weight:600">Open Owner Dashboard to assign manually</a></p>
          </div>`,
        }).catch(e => console.error('expire-offers: alert email error', e));

        console.log(`expire-offers: flagged ${booking.ref} for manual dispatch after ${attempt} attempts`);
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
