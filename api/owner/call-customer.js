import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { ownerCallConfig, buildOwnerLegRequest, placeCall } from '../_owner-call.js';

/**
 * POST /api/owner/call-customer — put the owner on the phone with a customer
 * without exposing the owner's personal number.
 *
 * The customer number is read from the booking, never taken from the request.
 * An owner password does not entitle the caller to dial an arbitrary number
 * through the business line, and accepting one from the browser would turn this
 * endpoint into an open dialer the moment that password leaked.
 *
 * Mechanics and the reason this exists live in api/_owner-call.js.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const config = ownerCallConfig();
  if (!config.enabled) {
    // Article 16: say why, rather than failing with a shrug.
    return res.status(503).json({
      error: 'Calling is not configured yet. Missing: ' + config.missing.join(', ') + '.',
      code: 'CALLING_NOT_CONFIGURED',
    });
  }

  const bookingId = String(req.body?.bookingId || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const sb = getSupabase();
  const { data: booking, error } = await sb
    .from('bookings')
    .select('id, ref, customer_name, customer_phone, status')
    .eq('id', bookingId)
    .maybeSingle();

  if (error) {
    console.error('[owner-call] booking lookup failed:', error.message || error);
    return res.status(503).json({ error: 'The booking could not be loaded. Please try again.' });
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const leg = buildOwnerLegRequest(config, {
    customerPhone: booking.customer_phone,
    bookingId: booking.id,
    bookingRef: booking.ref,
  });
  if (!leg.ok) return res.status(400).json({ error: leg.error, code: 'NO_CUSTOMER_PHONE' });

  const result = await placeCall(config, leg.body);
  if (!result.ok) {
    console.error('[owner-call] Telnyx rejected the call:', result.error);
    await sb.from('operational_events').insert({
      event_type: 'owner_call_failed',
      route: '/api/owner/call-customer',
      method: 'POST',
      actor_role: 'owner',
      stage: 'owner_leg',
      reason_code: 'telnyx_rejected',
      reason_detail: String(result.error).slice(0, 200),
      mutation_result: 'no_call_placed',
      payload: { ref: booking.ref },
    }).catch(() => {});
    return res.status(502).json({ error: 'The call could not be placed: ' + result.error });
  }

  await sb.from('operational_events').insert({
    event_type: 'owner_call_started',
    route: '/api/owner/call-customer',
    method: 'POST',
    actor_role: 'owner',
    stage: 'owner_leg',
    reason_code: 'owner_initiated_call',
    reason_detail: booking.ref || '',
    mutation_result: 'owner_leg_dialing',
    payload: { ref: booking.ref, callControlId: result.callControlId },
  }).catch(() => {});

  // Deliberately does not return the customer's number — the browser already
  // has what it needs, and this response ends up in logs.
  return res.status(200).json({
    ok: true,
    ringing: 'owner',
    message: 'Your phone is ringing. Answer it and we will connect '
      + (booking.customer_name || 'the customer') + '.',
  });
}
