import { createHash } from 'node:crypto';
import { normalizeUsPhone } from './_phone.js';

const CALL_CONTROL_ID = /^v3:[A-Za-z0-9_+/=-]{10,1000}$/;
const ASSISTANT_ID = /^assistant-[A-Za-z0-9-]{20,100}$/;
const FAILED_UNANSWERED_CAUSES = new Set(['timeout', 'user_busy', 'user_rejected']);

const digest = value => createHash('sha256').update(value).digest('hex');

export function overflowConfig(env = process.env) {
  const apiKey = String(env.TELNYX_API_KEY || '').trim();
  const publicKey = String(env.TELNYX_PUBLIC_KEY || '').trim();
  const connectionId = String(env.TELNYX_OVERFLOW_CONNECTION_ID || '').trim();
  const businessNumber = normalizeUsPhone(env.TELNYX_OVERFLOW_BUSINESS_NUMBER);
  const humanDestination = normalizeUsPhone(env.TELNYX_OVERFLOW_HUMAN_DESTINATION);
  const assistantId = String(env.TELNYX_OVERFLOW_ASSISTANT_ID || '').trim();
  const timeoutSecs = Number(env.TELNYX_OVERFLOW_TIMEOUT_SECS || 20);
  const missing = [];
  if (!apiKey) missing.push('TELNYX_API_KEY');
  if (!publicKey || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) missing.push('TELNYX_PUBLIC_KEY');
  if (!/^\d{1,30}$/.test(connectionId)) missing.push('TELNYX_OVERFLOW_CONNECTION_ID');
  if (!businessNumber) missing.push('TELNYX_OVERFLOW_BUSINESS_NUMBER');
  if (!humanDestination) missing.push('TELNYX_OVERFLOW_HUMAN_DESTINATION');
  if (!ASSISTANT_ID.test(assistantId)) missing.push('TELNYX_OVERFLOW_ASSISTANT_ID');
  if (!Number.isInteger(timeoutSecs) || timeoutSecs < 10 || timeoutSecs > 45) missing.push('TELNYX_OVERFLOW_TIMEOUT_SECS (10-45)');
  if (env.TELNYX_OVERFLOW_ASSISTANT_VERSION_CONFIRMED !== 'true') missing.push('TELNYX_OVERFLOW_ASSISTANT_VERSION_CONFIRMED');
  if (env.TELNYX_OVERFLOW_RECORDING_OFF_CONFIRMED !== 'true') missing.push('TELNYX_OVERFLOW_RECORDING_OFF_CONFIRMED');

  const production = env.VERCEL_ENV === 'production'
    && (!env.VERCEL_TARGET_ENV || env.VERCEL_TARGET_ENV === 'production');
  return { enabled: env.TELNYX_OVERFLOW_ENABLED === 'true' && production && missing.length === 0,
    apiKey, publicKey, connectionId, businessNumber, humanDestination, assistantId, timeoutSecs, missing };
}

function clientState(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

export function parseOverflowClientState(encoded) {
  try {
    const value = JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'));
    if (!value || value.v !== 1 || value.flow !== 'sora_overflow' || !CALL_CONTROL_ID.test(value.callerCallControlId || '')) return null;
    if (value.stage === 'caller' || value.stage === 'human_transfer' || value.stage === 'machine_hangup'
      || value.stage === 'fallback_speech') return value;
    return null;
  } catch { return null; }
}

function commandId(action, callControlId) {
  return `aae-overflow-${action}-${digest(callControlId).slice(0, 28)}`;
}

export function buildOverflowAnswer(config, callControlId) {
  return { command_id: commandId('answer', callControlId),
    client_state: clientState({ v: 1, flow: 'sora_overflow', stage: 'caller', callerCallControlId: callControlId }) };
}

export function buildOverflowTransfer(config, callControlId) {
  const state = { v: 1, flow: 'sora_overflow', stage: 'human_transfer', callerCallControlId: callControlId };
  return { to: config.humanDestination, timeout_secs: config.timeoutSecs,
    answering_machine_detection: 'detect', park_after_unbridge: 'self',
    command_id: commandId('human-transfer', callControlId),
    client_state: clientState({ ...state, stage: 'caller' }),
    target_leg_client_state: clientState(state) };
}

export function isUnansweredHumanFailure(payload) {
  const cause = String(payload?.hangup_cause || '').toLowerCase();
  return !payload?.answered_at && FAILED_UNANSWERED_CAUSES.has(cause);
}

export function buildOverflowAssistantStart(config, callControlId, greeting = null) {
  return { assistant: { id: config.assistantId, dynamic_variables: { overflow_route: true } },
    greeting: greeting || "Sorry, we can't connect you with a team member right now. I'm Sora, AssembleAtEase's virtual assistant. I can help take the details of your request.",
    command_id: commandId('start-sora', callControlId) };
}

export function buildOverflowSpeech(callControlId) {
  return { payload: 'We are unable to connect you right now. Please visit assembleatease.com/contact or email service@assembleatease.com. Goodbye.',
    payload_type: 'text', service_level: 'basic', voice: 'female', language: 'en-US', target_legs: 'self',
    command_id: commandId('fallback-speech', callControlId),
    client_state: clientState({ v: 1, flow: 'sora_overflow', stage: 'fallback_speech', callerCallControlId: callControlId }) };
}

export function buildOverflowHangup(callControlId) {
  return { command_id: commandId('fallback-hangup', callControlId) };
}

export async function sendTelnyxCommand(config, callControlId, action, body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://api.telnyx.com/v2/calls/${encodeURIComponent(callControlId)}/actions/${action}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok) return { ok: true, status: response.status };
    return { ok: false, status: response.status, code: result?.errors?.[0]?.code || null };
  } catch { return { ok: false, ambiguous: true }; }
}

export function telnyxCallControlEvent(raw) {
  const value = JSON.parse(raw.toString('utf8'));
  const data = value?.data;
  const payload = data?.payload;
  if (data?.record_type !== 'event' || typeof data.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.id)
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof data.event_type !== 'string') throw new Error('Invalid Telnyx call event');
  return { type: data.event_type.toLowerCase(), payload };
}

export function isOverflowInbound(payload, config) {
  return payload.direction === 'incoming' && normalizeUsPhone(payload.to) === config.businessNumber
    && CALL_CONTROL_ID.test(payload.call_control_id || '');
}

export function overflowCommandReference(callControlId) {
  return digest(callControlId).slice(0, 16);
}

export function buildOverflowMachineHangup(humanCallControlId, callerCallControlId) {
  return { command_id: commandId('machine-hangup', humanCallControlId),
    client_state: clientState({ v: 1, flow: 'sora_overflow', stage: 'machine_hangup', callerCallControlId }) };
}
