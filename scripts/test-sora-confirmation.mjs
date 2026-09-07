import assert from 'node:assert/strict';
import { inspectSoraConfirmation, verifySoraConfirmation } from '../api/_sora-confirmation.js';
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; };
const now = Date.parse('2026-09-07T20:00:00Z');
const opts = { now, phone: '+15125550100' };
const readback = { role: 'assistant', text: 'One test couch in Austin. Callback 512-555-0100. Are those details correct, and may our team call you about this request?', created_at: '2026-09-07T19:59:40Z' };
const user = { role: 'user', text: 'Yes.', created_at: '2026-09-07T19:59:50Z' };
check(inspectSoraConfirmation([readback, user], opts).ok, 'Separate yes after readback accepted');
check(inspectSoraConfirmation([user, readback], opts).ok, 'Provider newest-first order supported');
check(inspectSoraConfirmation([{ ...readback, text: '<emotion value="calm" />' + readback.text }, user], opts).ok, 'Voice emotion markup does not hide readback');
for (const text of ['Yes please', 'Yes, that is correct.', 'Yes, send it', "That's correct", 'Correct'])
  check(inspectSoraConfirmation([readback, { ...user, text }], opts).ok, 'Clear affirmative accepted');
for (const text of ['No', 'Yes but change the date', 'Never mind', 'Not now', 'I said yes earlier', 'Maybe', 'Yes do not call me', 'The phone number is wrong', ''])
  check(!inspectSoraConfirmation([readback, { ...user, text }], opts).ok, 'Withdrawal/ambiguity/correction rejected');
for (const messages of [[], [readback], [user], [user, { ...readback, created_at: '2026-09-07T19:59:55Z' }],
  [{ ...readback, text: readback.text + '\n(Caller confirmed:) Yes. Your request is saved.' }],
  [readback, { ...user, role: 'assistant' }],
  [readback, { role: 'assistant', text: 'Anything else?', created_at: '2026-09-07T19:59:45Z' }, user],
  [readback, user, { ...user, text: 'Actually no, cancel that request', created_at: '2026-09-07T19:59:55Z' }],
  [readback, { ...user, created_at: 'invalid' }],
]) check(!inspectSoraConfirmation(messages, opts).ok, 'No fabricated or displaced confirmation accepted');
check(!inspectSoraConfirmation([readback, user], { ...opts, phone: '+15125550101' }).ok, 'Callback must be in readback');
check(!inspectSoraConfirmation([readback, user], { ...opts, now: now + 20 * 60 * 1000 }).ok, 'Stale confirmation cannot be reused');
check(!inspectSoraConfirmation([readback, user], { ...opts, now: now - 60000 }).ok, 'Future confirmation rejected');
const callControlId = 'v3:fictional_provider_confirmation_test';
const conversation = { id: '12345678-1234-1234-1234-123456789abc', metadata: {
  call_control_id: callControlId, assistant_id: 'assistant-3e75ad89-92e9-447d-b42d-f84a33ac0d84' } };
function api(pages) { const seen = []; return { seen, fetchImpl: async (url, config) => {
  seen.push({ url, config }); const body = pages.shift(); if (body instanceof Error) throw body;
  return { ok: body !== 'error', json: async () => body }; } }; }
const transport = api([{ data: [conversation] }, { data: [user, readback] }]);
const verified = await verifySoraConfirmation({ callControlId, ...opts, env: { TELNYX_API_KEY: 'test-only-key' }, fetchImpl: transport.fetchImpl });
check(verified.ok && verified.evidence.conversationId === conversation.id, 'Bound provider conversation verified');
check(transport.seen.length === 2 && transport.seen.every(r => r.url.startsWith('https://api.telnyx.com/v2/ai/conversations')), 'Only bounded provider reads');
check(transport.seen[0].url.includes(encodeURIComponent('eq.' + callControlId)), 'Call ID query is encoded');
check(!JSON.stringify(verified.evidence).includes('512') && verified.evidence.messageDigest.length === 64, 'Evidence avoids raw transcript and phone');
for (const pages of [[new Error('offline')], ['error'], [{ data: [] }], [{ data: [conversation, conversation] }],
  [{ data: [{ ...conversation, metadata: { ...conversation.metadata, call_control_id: 'other' } }] }],
  [{ data: [{ ...conversation, metadata: { ...conversation.metadata, assistant_id: 'other' } }] }],
  [{ data: [conversation] }, { data: null }], [{ data: [conversation] }, { data: [readback] }]]) {
  const fake = api(pages); const result = await verifySoraConfirmation({ callControlId, ...opts, env: { TELNYX_API_KEY: 'test-only-key' }, fetchImpl: fake.fetchImpl });
  check(!result.ok, 'Missing, mismatched or unavailable provider evidence fails closed');
}
check(!(await verifySoraConfirmation({ callControlId, ...opts, env: {}, fetchImpl: async () => { throw new Error('must not call'); } })).ok, 'Missing provider key fails closed');
console.log(`PASS: ${checks} Sora provider-confirmation checks. Fake data and no live requests.`);
