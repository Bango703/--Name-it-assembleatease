import { createHash, createPublicKey, verify } from 'node:crypto';
import { intakeCallReference } from './_ai-intake-validation.js';

export const VOICE_EVENT = 'telnyx_voice_event';
export const VOICE_REVIEW = 'telnyx_voice_review';
export const CALL_REF = /^call_[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'canceled', 'failed', 'ended']);
const STATUS = new Set(['initiated', 'ringing', 'in-progress', ...TERMINAL]);
const JSON_STATUS = { 'call.initiated': 'initiated', 'call.answered': 'in-progress', 'call.hangup': 'ended' };
const hash = value => createHash('sha256').update(value).digest('hex');
const phone = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
const callRef = value => intakeCallReference({ callControlId: value });

export function voiceConfig(env = process.env) {
  const connections = String(env.TELNYX_VOICE_CONNECTION_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  const numbers = String(env.TELNYX_VOICE_BUSINESS_NUMBERS || '').split(',').map(v => phone(v.trim())).filter(Boolean);
  const enabled = env.TELNYX_VOICE_HISTORY_ENABLED === 'true' && env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production')
    && connections.length > 0 && connections.length <= 10 && connections.every(v => /^\d{1,30}$/.test(v))
    && /^[A-Za-z0-9+/]{43}=$/.test(env.TELNYX_PUBLIC_KEY || '');
  return { enabled, connections, numbers, publicKey: env.TELNYX_PUBLIC_KEY };
}

export function verifyVoiceSignature(raw, headers, publicKey, now = Date.now()) {
  try {
    const timestamp = headers['telnyx-timestamp'];
    const signature = headers['telnyx-signature-ed25519'];
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
      || Math.abs(now / 1000 - Number(timestamp)) > 300
      || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const key = Buffer.from(publicKey, 'base64');
    if (key.length !== 32) return false;
    const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' });
    return verify(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]), publicObject, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

export function voiceRowId(value) {
  const bytes = Buffer.from(hash('aae-voice-history-v1:' + value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function date(value, now) {
  // Live TeXML callbacks use a space separator and microseconds; Voice API
  // examples use T. Require an explicit timezone in both, never local time.
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(time) && time > 0 && time <= now + 300000 ? new Date(time).toISOString() : null;
}

// Only this allowlist is persisted. Never store the raw payload, SIP URI, transcript,
// recording URL, client_state, payment digits, or a caller-provided display name.
export function parseVoiceEvent(raw, contentType, config, now = Date.now()) {
  let source, p, status, eventName, occurredAt, eventKey, reference, connection, sequence = null;
  if (contentType === 'application/x-www-form-urlencoded') {
    source = 'texml';
    const params = new URLSearchParams(raw.toString('utf8'));
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new Error('Duplicate form field');
    p = Object.fromEntries(params);
    connection = p.ConnectionId;
    if (!config.connections.includes(connection)) return { forbidden: true };
    if (p.CallbackSource !== 'call-progress-events') throw new Error('Invalid callback source');
    status = p.CallStatus;
    // Documented post-processing callback, not another phone lifecycle state.
    // Authenticate and validate its call context, but do not persist insights.
    if (status === 'analyzed') {
      if (!callRef(p.CallSid) || !date(p.Timestamp, now)) throw new Error('Invalid analysis callback');
      return { ignored: true };
    }
    if (!STATUS.has(status) || status === 'ended') throw new Error('Unsupported TeXML status');
    if (!/^\d{1,9}$/.test(p.SequenceNumber || '')) throw new Error('Invalid sequence');
    sequence = Number(p.SequenceNumber);
    reference = callRef(p.CallSid);
    if (p.CallControlId && callRef(p.CallControlId) !== reference) throw new Error('Call identifiers disagree');
    occurredAt = date(p.Timestamp, now);
    eventName = 'call.' + status;
    eventKey = `${source}:${connection}:${reference}:${sequence}`;
  } else if (contentType === 'application/json') {
    source = 'voice_api';
    const body = JSON.parse(raw.toString('utf8'));
    p = body?.data?.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Invalid payload');
    connection = p.connection_id;
    if (!config.connections.includes(connection)) return { forbidden: true };
    eventName = body.data.event_type;
    if (!Object.hasOwn(JSON_STATUS, eventName)) return { ignored: true };
    status = JSON_STATUS[eventName];
    reference = callRef(p.call_control_id);
    occurredAt = date(body.data.occurred_at, now);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.data.id || '')) throw new Error('Invalid event ID');
    eventKey = `${source}:${connection}:${body.data.id}`;
  } else throw new Error('Unsupported content type');
  if (!reference || !occurredAt) throw new Error('Missing call reference or event time');
  const from = phone(p.From ?? p.from);
  const to = phone(p.To ?? p.to);
  let direction = p.direction === 'incoming' ? 'inbound' : p.direction === 'outgoing' ? 'outbound' : 'unknown';
  if (source === 'texml') {
    if (config.numbers.includes(to) && !config.numbers.includes(from)) direction = 'inbound';
    else if (config.numbers.includes(from) && !config.numbers.includes(to)) direction = 'outbound';
  }
  const duration = p.CallDuration;
  const session = p.CallSessionId ?? p.call_session_id;
  const metadata = {
    version: 1, source, callReference: reference, connectionId: connection,
    status, eventName, occurredAt, sequence, from, to, direction,
    parentCallReference: p.ParentCallSid ? callRef(p.ParentCallSid) : null,
    sessionReference: typeof session === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(session) ? 'session_' + hash(session) : null,
    startedAt: date(p.StartTime ?? p.start_time ?? p.CallInitiatedAt, now),
    answeredAt: date(p.AnsweredTime, now),
    endedAt: date(p.EndTime ?? p.end_time, now),
    durationSeconds: typeof duration === 'string' && /^\d{1,6}$/.test(duration) && Number(duration) <= 86400 ? Number(duration) : null,
  };
  return { row: { id: voiceRowId(eventKey), booking_id: null, event_type: VOICE_EVENT,
    actor_type: 'system', actor_name: 'Telnyx', description: 'Verified phone call event',
    metadata, created_at: new Date(now).toISOString() } };
}

export function projectVoiceCall(rows, review = null, complete = true) {
  const events = [...new Map(rows.filter(r => r.event_type === VOICE_EVENT && CALL_REF.test(r.metadata?.callReference || ''))
    .map(r => [r.id, r])).values()].sort((a, b) => a.metadata.occurredAt.localeCompare(b.metadata.occurredAt) || a.id.localeCompare(b.id));
  if (!events.length) return null;
  const first = events[0], last = events.at(-1);
  const metadata = last.metadata;
  const terminals = events.filter(r => TERMINAL.has(r.metadata.status));
  const outcomes = new Set(terminals.map(r => r.metadata.status).filter(s => s !== 'ended'));
  let status = terminals.length ? (outcomes.size > 1 ? 'conflicting' : [...outcomes][0] || 'ended')
    : events.some(r => r.metadata.status === 'in-progress') ? 'in-progress'
    : events.some(r => r.metadata.status === 'ringing') ? 'ringing' : 'initiated';
  if (!complete) status = 'incomplete';
  const revision = hash(events.map(r => r.id).sort().join('|'));
  const latest = field => [...events].reverse().find(r => r.metadata[field] != null)?.metadata[field] ?? null;
  // Answer/hangup callbacks can omit direction; do not let their unknown
  // placeholder hide a direction already reported for this same call leg.
  const direction = [...events].reverse().find(r => ['inbound', 'outbound'].includes(r.metadata.direction))?.metadata.direction || 'unknown';
  return {
    reference: metadata.callReference, revision, status, complete,
    reviewed: complete && review?.metadata?.revision === revision,
    reviewedAt: review?.created_at || null, direction,
    from: latest('from'), to: latest('to'), parentReference: latest('parentCallReference'), sessionReference: latest('sessionReference'),
    firstObservedAt: first.metadata.occurredAt, lastObservedAt: last.metadata.occurredAt,
    receivedAt: events.map(r => r.created_at).sort().at(-1),
    durationSeconds: latest('durationSeconds'),
    terminalObserved: terminals.length > 0,
    events: events.map(r => ({ id: r.id, status: r.metadata.status, source: r.metadata.source,
      occurredAt: r.metadata.occurredAt, receivedAt: r.created_at, sequence: r.metadata.sequence })),
  };
}
