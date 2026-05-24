import { getSupabase } from '../_supabase.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { sendEmail, ownerEmail } from '../_email.js';
import { logCron } from './_cron-logger.js';

/**
 * GET /api/cron/auto-dispatch
 * Runs every 30 minutes via Vercel cron.
 *
 * Finds confirmed bookings that:
 *   - Have no assembler assigned
 *   - Are not paused
 *   - Are not flagged for manual dispatch
 *   - Have no open (sent) offers in dispatch_offers table
 *
 * Deduplication is now handled by checking dispatch_offers table
 * rather than the legacy 2-hour time window on booking.dispatch_offered_at.
 * Retry/expiry logic is handled by the expire-offers cron (every 10 min).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();

  // Confirmed, unassigned, not paused, not flagged
  const { data: candidates } = await sb
    .from('bookings')
    .select('id, ref, service, date')
    .eq('status', 'confirmed')
    .is('assembler_id', null)
    .eq('dispatch_paused', false)
    .eq('needs_manual_dispatch', false);

  if (!candidates?.length) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'Nothing to dispatch' });
  }

  // Filter out bookings that already have open (sent) offers in dispatch_offers table
  const { data: openOffers } = await sb
    .from('dispatch_offers')
    .select('booking_id')
    .in('booking_id', candidates.map(b => b.id))
    .eq('offer_status', 'sent')
    .gt('expires_at', new Date().toISOString());

  const bookingsWithOpenOffers = new Set((openOffers || []).map(o => o.booking_id));
  const toDispatch = candidates.filter(b => !bookingsWithOpenOffers.has(b.id));

  if (!toDispatch.length) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'All eligible bookings already have open offers' });
  }

  const results = [];
  const failed  = [];

  for (const booking of toDispatch) {
    try {
      const result = await dispatchBooking(booking.id);
      results.push({ ref: booking.ref, ...result });
      if (result.dispatched === 0) failed.push(booking);
    } catch (e) {
      console.error('auto-dispatch error for', booking.ref, e.message);
      failed.push(booking);
    }
  }

  // Alert owner about genuine dispatch failures (no Easers available, not just dedup skips)
  const noEaserFailed = failed.filter(b =>
    results.find(r => r.ref === b.ref)?.message?.includes('No')
  );
  if (noEaserFailed.length) {
    const list = noEaserFailed.map(b => `• ${b.ref} — ${b.service} on ${b.date}`).join('\n');
    sendEmail({
      to:   ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `${noEaserFailed.length} booking(s) need Easer assignment`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#dc2626">No Easers Available</h2>
        <p>${noEaserFailed.length} booking(s) could not be dispatched — no eligible Easers in the service area:</p>
        <pre style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:1rem;color:#991b1b">${list}</pre>
        <p>Check that Easers are marked available and have phone numbers on file.</p>
        <p><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">Open Owner Dashboard</a></p>
      </div>`,
    }).catch(() => {});
  }

  const dispatchedCount = results.filter(r => r.dispatched > 0).length;
  console.log('auto-dispatch:', { processed: toDispatch.length, dispatched: dispatchedCount, failed: failed.length });
  await logCron('auto-dispatch', { records: dispatchedCount, status: failed.length ? 'partial' : 'ok' });

  return res.status(200).json({
    ok: true,
    processed: toDispatch.length,
    dispatched: dispatchedCount,
    failed: failed.length,
    results,
  });
}
