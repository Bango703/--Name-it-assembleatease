import { getSupabase } from '../_supabase.js';
import { voiceConfig, verifyVoiceSignature } from '../_voice-call-history.js';
import { ownerCallConfig, parseClientState, buildCustomerLegRequest, placeCall } from '../_owner-call.js';
import { normalizeUsPhone } from '../_phone.js';
import { rateLimitKey } from '../_ratelimit.js';
import { evaluateCustomerContactRelease } from '../booking/_customer-contact-release.js';
import { ACTIVE_BOOKING_STATUSES } from '../_source-of-truth.js';

/**
 * POST /api/webhooks/telnyx-call-control — the second half of a click-to-call.
 *
 * When the owner's phone is answered, this dials the customer and bridges the
 * two legs. Nothing else in the platform can do that, because Telnyx only tells
 * us the owner picked up by calling this endpoint.
 *
 * Signature verification is the same Ed25519 check the messaging webhook uses,
 * and for the same reason: this endpoint is public, and without it anyone could
 * forge an answer event and make the business line dial a number of their
 * choosing. The number to dial is never read from the request body — it comes
 * from the client_state this platform itself created when the call started.
 */
export const config = { api: { bodyParser: false } };
const MAX_BYTES = 32768;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'no-store');

  const settings = voiceConfig(process.env);
  const publicKey = String(process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!publicKey) return res.status(503).json({ error: 'Call control is not configured' });

  let raw;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_BYTES) return res.status(413).json({ error: 'Payload too large' });
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
  } catch {
    return res.status(400).json({ error: 'Unable to read event' });
  }

  if (!verifyVoiceSignature(raw, req.headers || {}, publicKey, Date.now())) {
    console.warn('[call-control] signature rejected');
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const payload = event?.data?.payload || {};
  const eventType = String(event?.data?.event_type || '').toLowerCase();

  if (eventType === 'call.initiated' && payload.direction === 'incoming') {
    const result = await routeInboundBookingCall(payload);
    return res.status(200).json({ ok: true, ...result });
  }

  // Only the owner leg being answered starts a second call. Every other event
  // is acknowledged and ignored, so a hangup or a busy tone cannot dial anyone.
  if (eventType !== 'call.answered') return res.status(200).json({ ok: true, ignored: eventType });

  const state = parseClientState(payload.client_state);
  if (!state) return res.status(200).json({ ok: true, ignored: 'not an owner leg' });

  const callControlId = payload.call_control_id;
  if (!callControlId) return res.status(200).json({ ok: true, ignored: 'no call_control_id' });

  const cfg = ownerCallConfig();
  if (!cfg.enabled) {
    console.error('[call-control] owner answered but calling is unconfigured:', cfg.missing.join(', '));
    return res.status(200).json({ ok: true, ignored: 'unconfigured' });
  }

  const result = await placeCall(cfg, buildCustomerLegRequest(cfg, state, callControlId));

  const sb = getSupabase();
  try {
    await sb.from('operational_events').insert({
      event_type: result.ok ? 'owner_call_bridged' : 'owner_call_bridge_failed',
      route: '/api/webhooks/telnyx-call-control',
      method: 'POST',
      actor_role: 'cron',
      stage: 'customer_leg',
      reason_code: result.ok ? 'customer_leg_dialing' : 'customer_leg_rejected',
      reason_detail: result.ok ? (state.ref || '') : String(result.error).slice(0, 200),
      mutation_result: result.ok ? 'bridged' : 'not_bridged',
      payload: { ref: state.ref || null, bookingId: state.bookingId || null },
    });
  } catch { /* logging is never worth failing the request for */ }

  if (!result.ok) console.error('[call-control] customer leg failed:', result.error);

  // Always 200: a non-2xx makes Telnyx retry, which would dial the customer
  // again. One failed bridge is far better than a customer's phone ringing
  // repeatedly.
  return res.status(200).json({ ok: true, bridged: result.ok, settingsEnabled: settings.enabled });
}

async function routeInboundBookingCall(payload) {
  const callControlId = String(payload.call_control_id || '').trim();
  const caller = normalizeUsPhone(payload.from?.phone_number || payload.from);
  const connectionId = String(payload.connection_id || '').trim();
  const cfg = ownerCallConfig();
  if (!callControlId || !caller || !connectionId || !cfg.apiKey || !cfg.from) {
    return { routed: false, ignored: 'missing_call_fields' };
  }

  // Caller ID is a ROUTING HINT, never an identity claim. It is trivially
  // spoofed, so nothing here discloses anything on the strength of it: the
  // bridge rings a number this platform already holds, and neither party ever
  // learns the other's. What spoofing could still buy is making an Easer's
  // phone ring on repeat, so a number gets a small budget of attempts.
  if (!await rateLimitKey(`inbound-call:${caller}`, 'default')) {
    return { routed: false, ignored: 'rate_limited' };
  }

  const sb = getSupabase();
  const now = Date.now();
  const { data: customerBookings } = await sb.from('bookings')
    .select('id, ref, customer_phone, assembler_id, assembler_name, assembler_accepted_at, status, date, time')
    .eq('customer_phone', caller)
    .in('status', ACTIVE_BOOKING_STATUSES)
    .not('assembler_id', 'is', null)
    .not('assembler_accepted_at', 'is', null)
    .order('date', { ascending: true })
    .limit(10);

  const eligibleCustomerBookings = (customerBookings || []).filter(row => evaluateCustomerContactRelease(row, now).released);
  let booking = eligibleCustomerBookings.length === 1 ? eligibleCustomerBookings[0] : null;
  let callerType = 'customer';
  let destination = null;

  if (booking) {
    const { data: easer } = await sb.from('profiles')
      .select('phone')
      .eq('id', booking.assembler_id)
      .eq('role', 'assembler')
      .maybeSingle();
    destination = normalizeUsPhone(easer?.phone);
  } else {
    const { data: easers } = await sb.from('profiles')
      .select('id, phone')
      .eq('role', 'assembler');
    const easer = (easers || []).find(row => normalizeUsPhone(row.phone) === caller);
    if (easer) {
      const { data: easerBookings } = await sb.from('bookings')
        .select('id, ref, customer_phone, assembler_id, assembler_name, assembler_accepted_at, status, date, time')
        .eq('assembler_id', easer.id)
        .in('status', ACTIVE_BOOKING_STATUSES)
        .not('assembler_accepted_at', 'is', null)
        .order('date', { ascending: true })
        .limit(10);
      const eligibleEaserBookings = (easerBookings || []).filter(row => evaluateCustomerContactRelease(row, now).released);
      booking = eligibleEaserBookings.length === 1 ? eligibleEaserBookings[0] : null;
      callerType = 'easer';
      destination = normalizeUsPhone(booking?.customer_phone);
    }
  }

  if (!booking || !destination || destination === caller) {
    return { routed: false, ignored: 'no_active_booking_match' };
  }

  const answer = await callControlRequest(cfg.apiKey, `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/answer`, {
    webhook_url: 'https://www.assembleatease.com/api/webhooks/telnyx-call-control',
  });
  if (!answer.ok) return { routed: false, ignored: 'answer_failed' };

  const outbound = await callControlRequest(cfg.apiKey, 'https://api.telnyx.com/v2/calls', {
    connection_id: connectionId,
    to: destination,
    from: cfg.from,
    link_to: callControlId,
    timeout_secs: 45,
    client_state: Buffer.from(JSON.stringify({
      v: 1,
      stage: 'booking_bridge',
      bookingId: booking.id,
      ref: booking.ref,
      callerType,
    })).toString('base64'),
  });
  try {
    await sb.from('operational_events').insert({
      event_type: outbound.ok ? 'booking_call_bridged' : 'booking_call_bridge_failed',
      route: '/api/webhooks/telnyx-call-control',
      method: 'POST',
      actor_role: 'system',
      stage: 'booking_bridge',
      reason_code: outbound.ok ? 'matched_active_booking' : 'destination_call_rejected',
      reason_detail: booking.ref || '',
      mutation_result: outbound.ok ? 'bridged' : 'not_bridged',
      payload: { bookingId: booking.id, callerType },
    });
  } catch { /* operational logging must not change call routing */ }
  // The call was answered before the second leg was placed, so a failure here
  // leaves someone listening to silence on a line we picked up. Say what
  // happened and hang up rather than let them wait it out.
  if (!outbound.ok) {
    await callControlRequest(cfg.apiKey, `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      payload: 'Sorry, we could not connect you right now. Please try again in a moment.',
      voice: 'female',
      language: 'en-US',
    });
    await callControlRequest(cfg.apiKey, `https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {});
  }

  return { routed: outbound.ok, bookingRef: booking.ref, callerType };
}

async function callControlRequest(apiKey, url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    return response.ok ? { ok: true, data } : { ok: false, error: data?.errors?.[0]?.detail || `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
