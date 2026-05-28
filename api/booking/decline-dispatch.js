import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { enforceEaserOperationalEligibility } from '../_easer-eligibility.js';

/**
 * POST /api/booking/decline-dispatch
 * Easer declines a dispatch offer.
 * Requires Easer JWT auth.
 * Body: { bookingId, token, reason? }
 *
 * Reason values: scheduling_conflict | too_far | not_my_skill | unavailable | other
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const { bookingId, token, reason } = req.body;
  if (!bookingId || !token) return res.status(400).json({ error: 'bookingId and token are required' });

  const sb = getSupabase();
  const eligibility = await enforceEaserOperationalEligibility(sb, user.id);
  if (!eligibility.ok) {
    return res.status(403).json({ error: eligibility.error, code: eligibility.code, status: eligibility.status || null });
  }

  const now = new Date().toISOString();

  // ── Find open offer ────────────────────────────────────────────────────────
  const { data: offer } = await sb
    .from('dispatch_offers')
    .select('*')
    .eq('token', token)
    .eq('easer_id', user.id)
    .eq('booking_id', bookingId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .maybeSingle();

  if (!offer) {
    // Check if it already expired or was declined
    const { data: anyOffer } = await sb
      .from('dispatch_offers')
      .select('offer_status')
      .eq('token', token)
      .maybeSingle();

    if (anyOffer?.offer_status === DISPATCH_OFFER_STATUS.EXPIRED) {
      return res.status(410).json({ error: 'Offer already expired' });
    }
    if (anyOffer?.offer_status === DISPATCH_OFFER_STATUS.ACCEPTED || anyOffer?.offer_status === DISPATCH_OFFER_STATUS.SUPERSEDED) {
      return res.status(409).json({ error: 'Job was already accepted' });
    }
    return res.status(404).json({ error: 'Offer not found or already resolved' });
  }

  // Mark offer declined
  await sb.from('dispatch_offers').update({
    offer_status: DISPATCH_OFFER_STATUS.DECLINED,
    declined_at: now,
    decline_reason: reason || 'no_reason',
  }).eq('id', offer.id);

  // Apply 2-hour decline penalty to Easer profile
  await sb.from('profiles')
    .update({ last_dispatch_declined_at: now })
    .eq('id', user.id);

  // Get Easer name for notifications
  const { data: easer } = await sb.from('profiles').select('full_name').eq('id', user.id).single();
  const easerName = easer?.full_name || 'An Easer';

  // Get booking for context
  const { data: booking } = await sb
    .from('bookings')
    .select('ref, service, customer_name, assembler_id, dispatch_attempt')
    .eq('id', bookingId)
    .single();

  // Notify owner of decline (non-blocking)
  const reasonLabels = {
    scheduling_conflict: 'Scheduling conflict',
    too_far: 'Location too far',
    not_my_skill: 'Outside my skill set',
    unavailable: 'Currently unavailable',
    other: 'Other',
  };
  sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Offer Declined — ${esc(booking?.ref || bookingId)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h3 style="color:#f59e0b">Job Offer Declined</h3>
      <p><strong>${esc(easerName)}</strong> declined the offer for booking <strong>${esc(booking?.ref || '')}</strong> (${esc(booking?.service || '')}).</p>
      <p><strong>Reason:</strong> ${esc(reasonLabels[reason] || reason || 'No reason given')}</p>
      <p>The dispatch engine will automatically retry if other Easers are available.</p>
      <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
    </div>`,
  }).catch(() => {});

  // Check if all offers for this booking are now resolved — if so, trigger next round
  const { data: remainingOpen } = await sb
    .from('dispatch_offers')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);

  logActivity(sb, {
    bookingId,
    eventType: 'dispatch_offer_declined',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: `${easerName} declined dispatch offer${booking?.ref ? ` for ${booking.ref}` : ''}`,
    metadata: {
      reason: reason || 'no_reason',
      remainingOpen: (remainingOpen || []).length,
      attempt: booking?.dispatch_attempt || null,
    },
  });

  if ((remainingOpen || []).length === 0 && booking && !booking.assembler_id) {
    // All offers declined — the expire-offers cron will handle retry logic,
    // but we trigger immediately if there are remaining attempts
    const MAX_ATTEMPTS = parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10);
    if ((booking.dispatch_attempt || 0) < MAX_ATTEMPTS) {
      dispatchBooking(bookingId).catch(e => console.error('decline-dispatch: retry error', e.message));
    }
  }

  console.log(`decline-dispatch: ${easerName} declined ${booking?.ref || bookingId}, reason=${reason}`);
  return res.status(200).json({ ok: true, message: 'Offer declined. You will not receive further offers for this job.' });
}
