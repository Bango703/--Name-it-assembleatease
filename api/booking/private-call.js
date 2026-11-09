import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { normalizeUsPhone } from '../_phone.js';
import { requireAssignedWorkEaser, respondWithEaserAccessError } from '../_easer-access.js';
import { customerBookingAccess, usesCustomerAccount } from './_customer-access.js';
import { privateLineConfig, privateLineOpen, leadEaserId, lineNumberFor, encodeState } from '../_private-line.js';
import { telnyxCommand } from '../webhooks/telnyx-private-line.js';

/**
 * POST /api/booking/private-call — "Call customer" (Easer) or "Call your pro"
 * (customer) through the private line (api/_private-line.js).
 *
 * Rings the person who pressed the button first, from the booking's pool
 * number; when they answer they hear the greeting, then the other person is
 * rung and must press 1 to connect (api/webhooks/telnyx-private-line.js).
 *
 * Easer:    Authorization: Bearer <token>, { bookingId }
 * Customer: { ref, email, token } or a signed-in customer account, { ref }
 */
const FIELDS = 'id, ref, status, date, time, customer_id, customer_email, customer_phone, guest_mutation_token_hash, assembler_id, assembler_accepted_at, completed_at, return_visit_required, return_visit_date, return_visit_time';

export default async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');
  const cfg = deps.cfg || privateLineConfig();
  if (!cfg.enabled) return res.status(409).json({ error: 'Calling through AssembleAtEase is not available yet. Use the message box on this job.', code: 'PRIVATE_CALLING_OFF' });

  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await (deps.rateLimit || rateLimit)(ip, 'booking'))) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const sb = deps.sb || getSupabase();
  const body = req.body || {};
  const asEaser = String(req.headers?.authorization || '').startsWith('Bearer ') && body.bookingId && !body.ref;
  let booking;
  let initiator;
  let destination;
  let callerType;

  if (asEaser) {
    const access = await (deps.easerAccess || requireAssignedWorkEaser)(req, { supabase: sb });
    if (!access.ok) return respondWithEaserAccessError(res, access);
    ({ data: booking } = await sb.from('bookings').select(FIELDS).eq('id', String(body.bookingId)).maybeSingle());
    if (!booking || (await leadEaserId(sb, booking)) !== access.user.id) return res.status(404).json({ error: 'Job not found' });
    const { data: me } = await sb.from('profiles').select('phone').eq('id', access.user.id).maybeSingle();
    initiator = normalizeUsPhone(me?.phone);
    destination = normalizeUsPhone(booking.customer_phone);
    callerType = 'easer';
    if (!initiator) return res.status(409).json({ error: 'Add your mobile number in your profile to call customers.', code: 'EASER_PHONE_MISSING' });
  } else {
    const { ref, email, token } = body;
    const viaAccount = usesCustomerAccount(req, { token });
    if (!ref || (!viaAccount && (!email || !token))) return res.status(400).json({ error: 'Open the latest link to your booking and try again.' });
    ({ data: booking } = await sb.from('bookings').select(FIELDS).eq('ref', String(ref).trim().toUpperCase()).maybeSingle());
    if (!booking || !(await (deps.customerAccess || customerBookingAccess)(sb, req, booking, { email, token })).ok) return res.status(404).json({ error: 'Booking not found' });
    initiator = normalizeUsPhone(booking.customer_phone);
    const easerId = await leadEaserId(sb, booking);
    const { data: easer } = easerId ? await sb.from('profiles').select('phone').eq('id', easerId).maybeSingle() : { data: null };
    destination = normalizeUsPhone(easer?.phone);
    callerType = 'customer';
    if (!initiator) return res.status(409).json({ error: 'Your booking has no mobile number on file. Use the message box to reach your pro.', code: 'CUSTOMER_PHONE_MISSING' });
  }

  if (!privateLineOpen(booking, deps.now || Date.now())) {
    return res.status(409).json({ error: 'Calling opens 24 hours before your appointment, once your pro has accepted the job.', code: 'PRIVATE_LINE_CLOSED' });
  }
  if (!destination) return res.status(409).json({ error: 'The other person has no phone number on file. Use the message box on this job.', code: 'DESTINATION_PHONE_MISSING' });

  const line = lineNumberFor(cfg, booking.id);
  const placed = await (deps.command || telnyxCommand)(cfg, null, 'dial', {
    connection_id: cfg.appId,
    to: initiator,
    from: line,
    from_display_name: 'AssembleAtEase',
    timeout_secs: 30,
    client_state: encodeState({ stage: 'initiator', line, bookingId: booking.id, callerType, destination }),
  });
  if (!placed.ok) return res.status(502).json({ error: 'The call could not be started. Try again in a moment.' });
  return res.status(200).json({ ok: true, message: 'Your phone will ring now. Answer it to be connected.' });
}
