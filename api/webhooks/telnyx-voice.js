import { createHash, createPublicKey, verify } from 'node:crypto';
import { getSupabase } from '../_supabase.js';
import { createOperationCase, buildOperationCaseRef } from '../_operation-cases.js';
import { intakeCallReference, intakeCallbackPhone } from '../_ai-intake-validation.js';

export const config = { api: { bodyParser: false } };
const MAX_BYTES = 32768;
const TYPES = new Set(['call.initiated', 'call.answered', 'call.hangup', 'call.conversation.ended']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function voiceEventsEnabled(env) {
  return env.TELNYX_AI_VOICE_EVENTS_ENABLED === 'true' && env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production')
    && /^\d{5,30}$/.test(env.TELNYX_AI_VOICE_CONNECTION_ID || '');
}

export function verifyVoiceSignature({ raw, signature, timestamp, publicKey, now = Date.now() }) {
  try {
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
        || Math.abs(now / 1000 - Number(timestamp)) > 300
        || typeof signature !== 'string' || typeof publicKey !== 'string') return false;
    const key = Buffer.from(publicKey, 'base64');
    const sig = Buffer.from(signature, 'base64');
    if (key.length !== 32 || sig.length !== 64) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]);
    return verify(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]),
      createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig);
  } catch { return false; }
}

function stableEventId(id) {
  const bytes = createHash('sha256').update('telnyx-voice:' + id).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function voiceEventProjection(event, connectionId, now = Date.now()) {
  const data = event?.data;
  if (!TYPES.has(data?.event_type)) return { ignored: true };
  const payload = data.payload;
  if (!payload || payload.connection_id !== connectionId) return { rejected: true };
  const reference = intakeCallReference({ callControlId: payload.call_control_id });
  const occurred = typeof data.occurred_at === 'string' ? Date.parse(data.occurred_at) : NaN;
  if (!reference || !UUID.test(data.id || '') || !Number.isFinite(occurred) || occurred > now + 300000) {
    return { error: true };
  }
  // Allowlist only. Never retain transcript, client_state, recordings, tokens,
  // payment/DTMF values, arbitrary hangup text, or inferred customer identity.
  return { value: {
    eventId: stableEventId(data.id), type: data.event_type, reference,
    occurredAt: new Date(occurred).toISOString(),
    from: intakeCallbackPhone(payload.from), to: intakeCallbackPhone(payload.to),
    sessionReference: UUID.test(payload.call_session_id || '')
      ? createHash('sha256').update(payload.call_session_id).digest('hex') : null,
    direction: ['incoming', 'outgoing'].includes(payload.direction) ? payload.direction : 'unknown',
  } };
}

export function createVoiceWebhook({ env = process.env, supabase = getSupabase,
  createCase = createOperationCase, newRef = buildOperationCaseRef, now = Date.now } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!voiceEventsEnabled(env)) return res.status(503).json({ error: 'Voice event intake is not enabled.' });
    let raw;
    try {
      const parts = []; let size = 0;
      for await (const part of req) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += bytes.length;
        if (size > MAX_BYTES) return res.status(413).json({ error: 'Payload too large' });
        parts.push(bytes);
      }
      raw = Buffer.concat(parts);
    } catch { return res.status(400).json({ error: 'Unable to read webhook' }); }
    if (!verifyVoiceSignature({ raw, signature: req.headers?.['telnyx-signature-ed25519'],
      timestamp: req.headers?.['telnyx-timestamp'], publicKey: env.TELNYX_PUBLIC_KEY, now: now() })) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }
    const parsed = voiceEventProjection(event, env.TELNYX_AI_VOICE_CONNECTION_ID, now());
    if (parsed.ignored) return res.status(200).json({ ok: true, ignored: true });
    if (parsed.rejected) return res.status(403).json({ error: 'Unexpected voice connection' });
    if (parsed.error) return res.status(400).json({ error: 'Incomplete voice event' });
    const input = parsed.value;
    try {
      const sb = supabase();
      // One call log per call leg, in the existing owner Cases workflow. This
      // is NOT a confirmed callback or a duplicate booking-status ledger.
      const saved = await createCase(sb, {
        caseRef: newRef('CALL'), caseType: 'support', source: 'system',
        sourceRef: 'telnyx-call:' + input.reference, severity: 'normal',
        subject: 'Phone call - review outcome',
        description: [
          'Provider-verified call log. Caller identity and callback consent are not verified.',
          `Call reference: ${input.reference}`,
          'Review the call timeline and any separately confirmed Sora request. An ended call does not prove a booking or callback request was completed.',
          'No transcript, recording, card data, account access or customer/Easer linkage is stored here.',
        ].join('\n'),
        customerName: null, customerPhone: null, customerEmail: null, easerId: null, bookingId: null,
        createdByType: 'system', createdByName: 'Sora (call lifecycle)',
        metadata: { channel: 'telnyx_voice', conversationId: input.reference,
          identityVerified: false, callbackConsent: false },
      });
      if (!saved?.id) throw new Error('Call log not saved');
      const { error } = await sb.from('operations_case_events').upsert({
        id: input.eventId, case_id: saved.id, event_type: 'internal_note', actor_type: 'system',
        actor_name: 'Telnyx voice events', created_at: input.occurredAt,
        note: `${input.type} at ${input.occurredAt}. Caller ID: ${input.from || 'withheld/unavailable'}; destination: ${input.to || 'unavailable'}. This event does not confirm a booking, identity or callback permission.`,
        metadata: { channel: 'telnyx_voice', providerEventType: input.type,
          conversationId: input.reference, sessionReference: input.sessionReference,
          direction: input.direction, identityVerified: false, callbackConsent: false },
      }, { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;
      return res.status(200).json({ ok: true });
    } catch {
      // Do not acknowledge lost events. Provider retries repair a partial write.
      return res.status(503).json({ error: 'Voice event could not be saved. Retry required.' });
    }
  };
}

export default createVoiceWebhook();
