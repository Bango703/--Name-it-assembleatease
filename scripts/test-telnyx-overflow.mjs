#!/usr/bin/env node
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { createTelnyxOverflowWebhook } from '../api/webhooks/telnyx-overflow.js';
import { overflowConfig, buildOverflowAnswer, buildOverflowTransfer, parseOverflowClientState } from '../api/_telnyx-overflow.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in Telnyx overflow tests'); };
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }

const now = Date.parse('2026-09-30T17:00:00Z');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const env = {
  TELNYX_API_KEY: 'offline-test-key', TELNYX_PUBLIC_KEY: publicKey,
  TELNYX_OVERFLOW_ENABLED: 'true', TELNYX_OVERFLOW_RECORDING_OFF_CONFIRMED: 'true',
  TELNYX_OVERFLOW_CONNECTION_ID: '1234567890', TELNYX_OVERFLOW_BUSINESS_NUMBER: '+19792325139',
  TELNYX_OVERFLOW_HUMAN_DESTINATION: '+17372906129',
  TELNYX_OVERFLOW_ASSISTANT_ID: 'assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84',
  TELNYX_OVERFLOW_TIMEOUT_SECS: '20', TELNYX_OVERFLOW_ASSISTANT_VERSION_CONFIRMED: 'true', VERCEL_ENV: 'production',
};
const settings = overflowConfig(env);
const callerCallControlId = 'v3:caller_call_control_0123456789';
const humanCallControlId = 'v3:human_call_control_0123456789';

function event(type, payload, id = randomUUID()) {
  return { data: { record_type: 'event', id, event_type: type, occurred_at: new Date(now).toISOString(), payload } };
}
function inboundEvent(callId = callerCallControlId, overrides = {}) {
  return event('call.initiated', { call_control_id: callId, connection_id: settings.connectionId,
    direction: 'incoming', from: '+15125550100', to: '+1 (979) 232-5139', ...overrides });
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
}
function mockFetch(statuses = [200]) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
    return { ok: status >= 200 && status < 300, status,
      json: async () => status >= 400 ? { errors: [{ code: status === 400 ? '10004' : '90061' }] } : { data: { result: 'ok' } } };
  };
  return { requests, fetchImpl };
}
async function invoke(handler, data, opts = {}) {
  const raw = Buffer.from(JSON.stringify(data));
  const timestamp = String(Math.floor(now / 1000));
  const req = Readable.from([raw]);
  req.method = opts.method || 'POST';
  req.headers = { 'content-type': 'application/json', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]), keys.privateKey).toString('base64'),
    ...opts.headers };
  const res = response();
  await handler(req, res);
  return res;
}

check(settings.enabled, 'Explicit production configuration and recording confirmation enable route');
for (const override of [
  { TELNYX_OVERFLOW_ENABLED: 'false' }, { TELNYX_OVERFLOW_RECORDING_OFF_CONFIRMED: 'false' },
  { TELNYX_OVERFLOW_ASSISTANT_VERSION_CONFIRMED: 'false' },
  { VERCEL_ENV: 'preview' }, { VERCEL_TARGET_ENV: 'preview' }, { TELNYX_OVERFLOW_CONNECTION_ID: '' },
  { TELNYX_OVERFLOW_TIMEOUT_SECS: '5' },
]) check(!overflowConfig({ ...env, ...override }).enabled, 'Route stays closed unless all gates are valid');

const offFetch = mockFetch();
const disabled = createTelnyxOverflowWebhook({ env: { ...env, TELNYX_OVERFLOW_ENABLED: 'false' }, fetchImpl: offFetch.fetchImpl, now: () => now });
check((await invoke(disabled, inboundEvent())).code === 503 && offFetch.requests.length === 0, 'Disabled route issues no provider command');

const fetch = mockFetch();
const handler = createTelnyxOverflowWebhook({ env, fetchImpl: fetch.fetchImpl, now: () => now });
let out = await invoke(handler, inboundEvent());
check(out.code === 200 && out.data.action === 'answered', 'Approved inbound caller leg is answered');
check(fetch.requests[0].url.endsWith(`/calls/${encodeURIComponent(callerCallControlId)}/actions/answer`), 'Answer uses only signed inbound call ID');
check(!Object.hasOwn(fetch.requests[0].body, 'record'), 'Answer does not request call recording');
check(parseOverflowClientState(fetch.requests[0].body.client_state)?.stage === 'caller', 'Answer pins signed caller-leg state');
const answerCommandId = fetch.requests[0].body.command_id;
await invoke(handler, inboundEvent());
check(fetch.requests[1].body.command_id === answerCommandId, 'Duplicate initiated webhook reuses Telnyx command ID');

const noMatch = mockFetch();
const noMatchHandler = createTelnyxOverflowWebhook({ env, fetchImpl: noMatch.fetchImpl, now: () => now });
out = await invoke(noMatchHandler, inboundEvent(callerCallControlId, { to: '+15125550199' }));
check(out.data.ignored && noMatch.requests.length === 0, 'Other destination number is ignored');
out = await invoke(noMatchHandler, inboundEvent(callerCallControlId, { direction: 'outgoing' }));
check(out.data.ignored && noMatch.requests.length === 0, 'Outbound call is ignored');
out = await invoke(noMatchHandler, inboundEvent(callerCallControlId, { connection_id: '999' }));
check(out.code === 403, 'Another Call Control connection is rejected');
out = await invoke(noMatchHandler, inboundEvent(), { headers: { 'telnyx-signature-ed25519': 'invalid' } });
check(out.code === 401, 'Unsigned call event is rejected');

const callerState = buildOverflowAnswer(settings, callerCallControlId).client_state;
out = await invoke(handler, event('call.answered', { connection_id: settings.connectionId,
  call_control_id: callerCallControlId, client_state: callerState }));
check(out.data.action === 'human transfer started', 'Answered caller leg attempts the fixed human destination');
const transfer = fetch.requests.at(-1);
check(transfer.url.endsWith(`/calls/${encodeURIComponent(callerCallControlId)}/actions/transfer`), 'Transfer operates on original caller leg');
check(transfer.body.to === settings.humanDestination && transfer.body.timeout_secs === settings.timeoutSecs, 'Transfer target and timeout are configured, not caller-controlled');
check(transfer.body.answering_machine_detection === 'detect' && transfer.body.park_after_unbridge === 'self', 'Voicemail detection keeps the original caller leg available for Sora');
check(parseOverflowClientState(transfer.body.target_leg_client_state)?.stage === 'human_transfer', 'Transfer leg carries signed overflow state');
check(!Object.hasOwn(transfer.body, 'record'), 'Human transfer does not request recording');
const requestsBeforeHumanAnswer = fetch.requests.length;
out = await invoke(handler, event('call.answered', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state }));
check(out.data.ignored === 'not the caller leg' && fetch.requests.length === requestsBeforeHumanAnswer,
  'Human answer bridges without starting Sora or another transfer');

out = await invoke(handler, event('call.hangup', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state,
  hangup_cause: 'normal_clearing', answered_at: new Date(now - 1000).toISOString() }));
check(out.data.ignored === 'human transfer did not fail unanswered', 'Human answer and normal hangup never start Sora');
const amdFetch = mockFetch([200, 200]);
const amdHandler = createTelnyxOverflowWebhook({ env, fetchImpl: amdFetch.fetchImpl, now: () => now });
out = await invoke(amdHandler, event('call.machine.detection.ended', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state, result: 'machine' }));
check(out.data.action === 'voicemail leg ended' && amdFetch.requests[0].url.endsWith(`/calls/${encodeURIComponent(humanCallControlId)}/actions/hangup`),
  'Confirmed voicemail pickup ends only the human leg');
const machineHangupState = amdFetch.requests[0].body.client_state;
out = await invoke(amdHandler, event('call.hangup', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: machineHangupState, hangup_cause: 'normal_clearing' }));
check(out.data.action === 'Sora started' && amdFetch.requests[1].url.endsWith(`/calls/${encodeURIComponent(callerCallControlId)}/actions/ai_assistant_start`),
  'Sora starts on the parked caller leg after voicemail disconnects');
const unsureFetch = mockFetch();
const unsureHandler = createTelnyxOverflowWebhook({ env, fetchImpl: unsureFetch.fetchImpl, now: () => now });
out = await invoke(unsureHandler, event('call.machine.detection.ended', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state, result: 'not_sure' }));
check(out.data.ignored === 'human or uncertain answer' && unsureFetch.requests.length === 0,
  'Uncertain AMD result never takes the caller away from the human route');
const aiCallsBeforeFailure = fetch.requests.filter(request => request.url.endsWith('/actions/ai_assistant_start')).length;
out = await invoke(handler, event('call.hangup', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state,
  hangup_cause: 'timeout' }));
check(out.data.action === 'Sora started', 'Unanswered timeout starts Sora on the preserved caller leg');
const aiStart = fetch.requests.at(-1);
check(aiStart.url.endsWith(`/calls/${encodeURIComponent(callerCallControlId)}/actions/ai_assistant_start`), 'Sora starts on original caller leg, not failed human leg');
check(aiStart.body.assistant.id === settings.assistantId && aiStart.body.assistant.dynamic_variables.overflow_route === true, 'Sora receives only the approved assistant and overflow marker');
check(aiStart.body.greeting.includes("can't connect you with a team member right now"), 'Overflow greeting is accurate without inventing call volume');
check(!Object.hasOwn(aiStart.body, 'record') && !Object.hasOwn(aiStart.body.assistant, 'record'), 'Sora start does not request recording');
out = await invoke(handler, event('call.hangup', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state,
  hangup_cause: 'timeout' }));
check(out.data.action === 'Sora started' && fetch.requests.at(-1).body.command_id === aiStart.body.command_id,
  'Duplicate transfer failure reuses the same Sora command ID');
check(fetch.requests.filter(request => request.url.endsWith('/actions/ai_assistant_start')).length === aiCallsBeforeFailure + 2,
  'Retries reach Telnyx only with the provider-deduplicated command ID');

for (const payload of [
  { hangup_cause: 'normal_clearing' }, { hangup_cause: 'timeout', answered_at: new Date(now).toISOString() },
  { hangup_cause: 'unrecognized-provider-cause' },
]) {
  out = await invoke(handler, event('call.hangup', { connection_id: settings.connectionId,
    call_control_id: humanCallControlId, client_state: transfer.body.target_leg_client_state, ...payload }));
  check(out.data.ignored === 'human transfer did not fail unanswered', 'Unknown or answered hangup cannot start Sora');
}

const transferFailure = mockFetch([422, 200]);
const transferFailureHandler = createTelnyxOverflowWebhook({ env, fetchImpl: transferFailure.fetchImpl, now: () => now });
out = await invoke(transferFailureHandler, event('call.answered', { connection_id: settings.connectionId,
  call_control_id: callerCallControlId, client_state: callerState }));
check(out.data.action === 'Sora started' && transferFailure.requests[1].url.endsWith('/actions/ai_assistant_start'),
  'Definitive rejected transfer enters Sora directly');

const startFailure = mockFetch([400, 200]);
const startFailureHandler = createTelnyxOverflowWebhook({ env, fetchImpl: startFailure.fetchImpl, now: () => now });
const targetState = buildOverflowTransfer(settings, callerCallControlId).target_leg_client_state;
out = await invoke(startFailureHandler, event('call.hangup', { connection_id: settings.connectionId,
  call_control_id: humanCallControlId, client_state: targetState, hangup_cause: 'user_busy' }));
check(out.data.action === 'spoken fallback started' && startFailure.requests[1].url.endsWith('/actions/speak'),
  'Definitive Sora-start refusal uses a spoken contact fallback');
check(!Object.hasOwn(startFailure.requests[1].body, 'record'), 'Spoken fallback does not request recording');
out = await invoke(startFailureHandler, event('call.speak.ended', { connection_id: settings.connectionId,
  call_control_id: callerCallControlId, client_state: startFailure.requests[1].body.client_state }));
check(out.data.action === 'fallback message ended' && startFailure.requests.at(-1).url.endsWith('/actions/hangup'),
  'Spoken fallback ends the caller leg after playback');

const uncertain = mockFetch([503]);
const uncertainHandler = createTelnyxOverflowWebhook({ env, fetchImpl: uncertain.fetchImpl, now: () => now });
out = await invoke(uncertainHandler, inboundEvent());
check(out.code === 503, 'Uncertain answer command remains retryable');
const network = createTelnyxOverflowWebhook({ env, fetchImpl: async () => { throw new Error('offline'); }, now: () => now });
out = await invoke(network, inboundEvent());
check(out.code === 503, 'Network-ambiguous answer remains retryable');

console.log(`PASS Telnyx overflow: ${checks} offline assertions; no real calls or provider requests.`);
