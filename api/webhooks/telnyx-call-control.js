import { getSupabase } from '../_supabase.js';
import { voiceConfig, verifyVoiceSignature } from '../_voice-call-history.js';
import { ownerCallConfig, parseClientState, buildCustomerLegRequest, placeCall } from '../_owner-call.js';

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
