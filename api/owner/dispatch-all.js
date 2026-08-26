import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { dispatchBooking } from '../booking/_dispatch-internal.js';
import { DISPATCH_PAYMENT_STATUSES, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';

/**
 * POST /api/owner/dispatch-all
 * Owner-triggered dispatch sweep for eligible confirmed bookings.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyOwner(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = getSupabase();
  // Load every confirmed, unassigned booking and partition it HERE rather than
  // filtering the exclusions away in SQL. Filtering in the query made a skipped
  // booking indistinguishable from a booking that does not exist, so the sweep
  // could only ever answer "Nothing to dispatch" — which reads as "you have no
  // work" when the truth is "the work you have needs a different action".
  const { data: allUnassigned, error: candidatesError } = await sb
    .from('bookings')
    .select('id, ref, payment_status, stripe_dispute_id, stripe_dispute_status, dispatch_paused, needs_manual_dispatch')
    .eq('status', 'confirmed')
    .is('assembler_id', null);

  if (candidatesError) {
    return res.status(503).json({ error: 'Unable to verify dispatch candidates.' });
  }

  const unassigned = allUnassigned || [];
  // Each bucket is a DIFFERENT owner action, so each is counted separately.
  const needsManual = unassigned.filter(b => b.needs_manual_dispatch === true);
  const paused = unassigned.filter(b => !b.needs_manual_dispatch && b.dispatch_paused === true);
  const eligibleByFlags = unassigned.filter(b => !b.needs_manual_dispatch && b.dispatch_paused !== true);
  const paymentNotReady = eligibleByFlags.filter(b => !DISPATCH_PAYMENT_STATUSES.includes(b.payment_status)
    || !isBookingPaymentReadyForDispatch(b));
  const paymentReadyCandidates = eligibleByFlags.filter(b => DISPATCH_PAYMENT_STATUSES.includes(b.payment_status)
    && isBookingPaymentReadyForDispatch(b));

  const skipped = {
    needsManualAssignment: needsManual.length,
    dispatchPaused: paused.length,
    paymentNotReady: paymentNotReady.length,
    alreadyOffered: 0,
  };

  // Say which action each skipped booking actually needs.
  function explain(extra) {
    const parts = [];
    if (skipped.needsManualAssignment) {
      parts.push(`${skipped.needsManualAssignment} outside the automatic-dispatch ZIPs — assign an Easer directly on the booking (Smart Dispatch cannot send offers for these)`);
    }
    if (skipped.dispatchPaused) parts.push(`${skipped.dispatchPaused} with dispatch paused`);
    if (skipped.paymentNotReady) parts.push(`${skipped.paymentNotReady} without a confirmed card authorization`);
    if (skipped.alreadyOffered) parts.push(`${skipped.alreadyOffered} already have live offers out`);
    if (extra) parts.push(extra);
    if (!unassigned.length) return 'No unassigned confirmed bookings — nothing is waiting on dispatch.';
    if (!parts.length) return 'Nothing to dispatch.';
    return `Nothing auto-dispatchable. ${unassigned.length} unassigned booking${unassigned.length === 1 ? '' : 's'}: ` + parts.join('; ') + '.';
  }

  if (!paymentReadyCandidates.length) {
    return res.status(200).json({
      ok: true, dispatched: 0, processed: 0,
      unassignedTotal: unassigned.length,
      skipped,
      message: explain(),
    });
  }

  const { data: openOffers, error: openOffersError } = await sb
    .from('dispatch_offers')
    .select('booking_id')
    .in('booking_id', paymentReadyCandidates.map(b => b.id))
    .eq('offer_status', 'sent')
    .gt('expires_at', new Date().toISOString());

  if (openOffersError) {
    return res.status(503).json({ error: 'Unable to verify existing dispatch offers.' });
  }

  const bookingsWithOpenOffers = new Set((openOffers || []).map(o => o.booking_id));
  const toDispatch = paymentReadyCandidates.filter(b => !bookingsWithOpenOffers.has(b.id));
  skipped.alreadyOffered = paymentReadyCandidates.length - toDispatch.length;
  if (!toDispatch.length) {
    return res.status(200).json({
      ok: true, dispatched: 0, processed: 0,
      unassignedTotal: unassigned.length,
      skipped,
      message: explain(),
    });
  }

  const results = [];
  let dispatched = 0;
  for (const booking of toDispatch) {
    try {
      const result = await dispatchBooking(booking.id);
      results.push({ bookingId: booking.id, ref: booking.ref, ...result });
      if (result && Number(result.dispatched || 0) > 0) dispatched += 1;
    } catch (error) {
      results.push({ bookingId: booking.id, ref: booking.ref, dispatched: 0, error: error?.message || String(error) });
    }
  }

  return res.status(200).json({
    ok: true,
    processed: toDispatch.length,
    dispatched,
    failed: toDispatch.length - dispatched,
    unassignedTotal: unassigned.length,
    skipped,
    message: dispatched
      ? `Dispatched ${dispatched} of ${toDispatch.length}.`
        + (skipped.needsManualAssignment ? ` ${skipped.needsManualAssignment} still need direct assignment (outside the automatic-dispatch ZIPs).` : '')
      : explain(`${toDispatch.length} attempted but no Easer was eligible — check Job Readiness on the Easers tab`),
    results,
  });
}
