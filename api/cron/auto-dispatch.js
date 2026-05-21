import { getSupabase } from '../_supabase.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { sendEmail, ownerEmail } from '../_email.js';

/**
 * GET /api/cron/auto-dispatch
 * Runs every 30 minutes via Vercel cron.
 * 1. Dispatches any confirmed bookings with no Easer assigned + no active offer.
 * 2. Re-dispatches offers that have been sitting >2 hours with no acceptance.
 * 3. Emails owner if any booking can't find an Easer.
 */
export default async function handler(req, res) {
  // Vercel cron calls with GET — allow internal calls too
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = getSupabase();
  const now = new Date();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

  // 1. Confirmed bookings with no Easer and no active dispatch offer
  const { data: unassigned } = await sb
    .from('bookings')
    .select('id, ref, service, date, address, dispatch_offered_at, dispatch_status')
    .eq('status', 'confirmed')
    .is('assembler_id', null)
    .or('dispatch_offered_at.is.null,dispatch_status.eq.none');

  // 2. Dispatched offers that timed out (>2hr, nobody accepted)
  const { data: timedOut } = await sb
    .from('bookings')
    .select('id, ref, service, date, address, dispatch_offered_at')
    .eq('status', 'confirmed')
    .is('assembler_id', null)
    .eq('dispatch_status', 'offered')
    .lt('dispatch_offered_at', twoHoursAgo);

  const toDispatch = [
    ...(unassigned || []),
    ...(timedOut || []),
  ];

  if (!toDispatch.length) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'Nothing to dispatch' });
  }

  const results = [];
  const failed = [];

  for (const booking of toDispatch) {
    try {
      const result = await dispatchBooking(booking.id);
      results.push({ ref: booking.ref, service: booking.service, ...result });
      if (result.dispatched === 0) failed.push(booking);
    } catch(e) {
      console.error('Cron dispatch error for', booking.ref, e.message);
      failed.push(booking);
    }
  }

  // Email owner about anything that couldn't find an Easer
  if (failed.length) {
    const failList = failed.map(b =>
      `• ${b.ref} — ${b.service || 'Service'} on ${b.date || 'TBD'}`
    ).join('\n');

    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `⚠️ ${failed.length} booking(s) need Easer assignment`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#dc2626">Action Needed: No Easers Available</h2>
        <p style="color:#374151">${failed.length} booking(s) could not be auto-dispatched because no eligible Easers are available in the area:</p>
        <pre style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:1rem;color:#991b1b;font-size:0.9rem">${failList}</pre>
        <p style="color:#374151">Possible reasons: no Easers marked available, no Easers in the service area, or no Easers have a phone number on file.</p>
        <p><a href="https://www.assembleatease.com/owner/" style="color:#0097a7">Open Owner Dashboard →</a></p>
      </div>`,
    }).catch(e => console.error('Failed alert email:', e.message));
  }

  return res.status(200).json({
    ok: true,
    processed: toDispatch.length,
    dispatched: results.filter(r => r.dispatched > 0).length,
    failed: failed.length,
    results,
  });
}
