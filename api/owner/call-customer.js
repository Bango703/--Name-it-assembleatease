import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { ownerCallConfig, buildOwnerLegRequest, placeCall } from '../_owner-call.js';
import { recordOperationalEvents } from '../_observability.js';
import { parseCallTarget, resolveCallTarget } from '../_owner-call-targets.js';
import { appendOperationCaseEvent } from '../_operation-cases.js';

/**
 * POST /api/owner/call-customer — put the owner on the phone with a customer,
 * caller, Easer or partner without exposing the owner's personal number.
 *
 * Body: { type, id } (see _owner-call-targets.js), or { bookingId } for the
 * booking's customer. The number is read from that record, never taken from
 * the request.
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

  const target = parseCallTarget(req.body);
  if (!target.ok) return res.status(400).json({ error: target.error });

  const sb = getSupabase();
  let who;
  try {
    who = await resolveCallTarget(sb, target);
  } catch (error) {
    console.error('[owner-call] target lookup failed:', error?.message || error);
    return res.status(503).json({ error: 'The record could not be loaded. Please try again.' });
  }
  if (!who.found) return res.status(404).json({ error: 'That record could not be found.' });
  const booking = { id: who.bookingId, ref: who.ref, customer_name: who.name };

  const leg = buildOwnerLegRequest(config, {
    customerPhone: who.phone,
    bookingId: who.bookingId,
    bookingRef: who.ref,
  });
  if (!leg.ok) {
    return res.status(400).json({ error: `${who.name} does not have a valid US phone number on file.`, code: 'NO_CUSTOMER_PHONE' });
  }
  const result = await placeCall(config, leg.body);
  if (!result.ok) {
    console.error('[owner-call] Telnyx rejected the call:', result.error);
    try {
      await recordOperationalEvents(sb, {
        event_type: 'owner_call_failed',
        route: '/api/owner/call-customer',
        method: 'POST',
        actor_role: 'owner',
        stage: 'owner_leg',
        reason_code: 'telnyx_rejected',
        reason_detail: String(result.error).slice(0, 200),
        mutation_result: 'no_call_placed',
        payload: { ref: booking.ref },
      });
    } catch { /* logging is never worth failing the request for */ }
    return res.status(502).json({ error: 'The call could not be placed: ' + result.error });
  }

  try {
    await recordOperationalEvents(sb, {
      event_type: 'owner_call_started',
      route: '/api/owner/call-customer',
      method: 'POST',
      actor_role: 'owner',
      stage: 'owner_leg',
      reason_code: 'owner_initiated_call',
      reason_detail: booking.ref || '',
      mutation_result: 'owner_leg_dialing',
      payload: { ref: booking.ref, type: target.type, callControlId: result.callControlId },
    });
  } catch { /* logging is never worth failing the request for */ }

  if (who.caseId) {
    await appendOperationCaseEvent(sb, {
      caseId: who.caseId, eventType: 'internal_note', actorType: 'owner', actorName: 'Owner',
      note: `Called ${who.name} from the business line.`,
    }).catch(error => console.error('[owner-call] case event failed:', error?.message || error));
  }

  // Deliberately does not return the customer's number — the browser already
  // has what it needs, and this response ends up in logs.
  return res.status(200).json({
    ok: true,
    ringing: 'owner',
    message: 'Your phone is ringing. Answer it and we will connect '
      + (booking.customer_name || 'the customer') + '.',
  });
}
