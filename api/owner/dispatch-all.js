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
  const { data: candidates, error: candidatesError } = await sb
    .from('bookings')
    .select('id, ref, payment_status, stripe_dispute_id, stripe_dispute_status')
    .eq('status', 'confirmed')
    .in('payment_status', DISPATCH_PAYMENT_STATUSES)
    .is('assembler_id', null)
    .eq('dispatch_paused', false)
    .eq('needs_manual_dispatch', false);

  if (candidatesError) {
    return res.status(503).json({ error: 'Unable to verify dispatch candidates.' });
  }

  const paymentReadyCandidates = (candidates || []).filter(isBookingPaymentReadyForDispatch);
  if (!paymentReadyCandidates.length) {
    return res.status(200).json({ ok: true, dispatched: 0, processed: 0, message: 'Nothing to dispatch' });
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
  if (!toDispatch.length) {
    return res.status(200).json({ ok: true, dispatched: 0, processed: 0, message: 'Eligible bookings already have open offers' });
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
    results,
  });
}
