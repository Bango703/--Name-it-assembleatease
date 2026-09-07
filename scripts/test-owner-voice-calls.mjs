import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ESLint } from 'eslint';
import globals from 'globals';
import { createVoiceWebhook } from '../api/webhooks/telnyx-voice.js';
import { createVoiceCallsHandler } from '../api/owner/voice-calls.js';
import { VOICE_EVENT, VOICE_REVIEW, voiceConfig, verifyVoiceSignature, parseVoiceEvent, projectVoiceCall, voiceRowId } from '../api/_voice-call-history.js';
import { intakeCallReference } from '../api/_ai-intake-validation.js';

globalThis.fetch = async () => { throw new Error('Network forbidden in phone history tests'); };
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const now = Date.parse('2026-09-07T02:00:00Z');
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const env = { TELNYX_VOICE_HISTORY_ENABLED: 'true', VERCEL_ENV: 'production', TELNYX_PUBLIC_KEY: publicKey,
  TELNYX_VOICE_CONNECTION_IDS: '123456789', TELNYX_VOICE_BUSINESS_NUMBERS: '+15125550101' };
const settings = voiceConfig(env);
const sid = 'v3:fictional_call_0123456789';
const ref = intakeCallReference({ callControlId: sid });
function form(overrides = {}) {
  return { AccountSid: randomUUID(), CallSid: sid, ConnectionId: '123456789', CallbackSource: 'call-progress-events',
    CallStatus: 'initiated', From: '+15125550100', To: '+15125550101', SequenceNumber: '0', Timestamp: new Date(now - 10000).toISOString(), ...overrides };
}
function jsonEvent(type = 'call.initiated', overrides = {}) {
  return { data: { id: randomUUID(), event_type: type, occurred_at: new Date(now - 10000).toISOString(), payload: {
    connection_id: '123456789', call_control_id: sid, direction: 'incoming', from: '+15125550100', to: '+15125550101', ...overrides } } };
}
function rawForm(value) { return Buffer.from(new URLSearchParams(value).toString()); }
function parseForm(value, received = now) { return parseVoiceEvent(rawForm(value), 'application/x-www-form-urlencoded', settings, received).row; }
function headers(raw, timestamp = String(now / 1000)) {
  return { 'content-type': 'application/x-www-form-urlencoded', 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp + '|'), raw]), keys.privateKey).toString('base64') };
}
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } }; }
function database(seed = {}, errors = {}) {
  const tables = { activity_logs: [], operations_cases: [], notification_log: [], ...structuredClone(seed) };
  const writes = []; const reads = [];
  function from(table) {
    assert.ok(Object.hasOwn(tables, table), 'No unrelated tables');
    const filters = []; const orders = []; let limit = Infinity; let write = null; let options; let orExpression;
    const field = (row, key) => key.includes('->>') ? row[key.split('->>')[0]]?.[key.split('->>')[1]] : row[key];
    const query = {
      select(columns) { reads.push({ table, columns }); return query; },
      eq(key, value) { filters.push(r => field(r, key) === value); return query; },
      is(key, value) { filters.push(r => field(r, key) === value); return query; },
      in(key, values) { filters.push(r => values.includes(field(r, key))); return query; },
      gte(key, value) { filters.push(r => field(r, key) >= value); return query; },
      order(key, opts) { orders.push({ key, asc: opts.ascending }); return query; },
      limit(value) { limit = value; return query; },
      or(value) { orExpression = value; return query; },
      upsert(row, opts) { write = structuredClone(row); options = opts; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (errors[table] || (write && errors.write)) return { error: { message: 'Fictional outage' }, data: null };
          if (write) {
            writes.push({ table, row: write, options });
            const i = tables[table].findIndex(r => r.id === write.id);
            if (i < 0) tables[table].push(write);
            else if (!options.ignoreDuplicates) tables[table][i] = write;
            return { error: null, data: null };
          }
          let rows = tables[table].filter(r => filters.every(f => f(r)));
          if (orExpression) {
            const match = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.[^,]+,id\.lt\.([a-f0-9-]+)\)$/.exec(orExpression);
            assert.ok(match, 'Cursor uses validated fields');
            rows = rows.filter(r => r.created_at < match[1] || (r.created_at === match[1] && r.id < match[2]));
          }
          rows.sort((a, b) => {
            for (const { key, asc } of orders) { const compare = String(field(a, key)).localeCompare(String(field(b, key))); if (compare) return asc ? compare : -compare; }
            return 0;
          });
          return { data: structuredClone(rows.slice(0, limit)), error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  }
  return { tables, writes, reads, from };
}
async function webhook(db, value = form(), opts = {}) {
  const raw = opts.raw || rawForm(value);
  const req = Readable.from([raw]); req.method = opts.method || 'POST'; req.headers = { ...headers(raw), ...opts.headers };
  const res = response();
  await createVoiceWebhook({ env: { ...env, ...opts.env }, now: () => now, supabase: () => db })(req, res);
  check(res.headers['Cache-Control'] === 'no-store', 'Webhook response cannot be cached');
  return res;
}
async function owner(db, query = {}, opts = {}) {
  const res = response();
  await createVoiceCallsHandler({ env: { ...env, ...opts.env }, now: () => now, supabase: () => db, authorize: () => opts.authorized !== false })
    ({ method: opts.method || 'GET', query, body: opts.body, headers: {} }, res);
  check(res.headers['Cache-Control'] === 'no-store', 'Private history cannot be cached');
  return res;
}

check(settings.enabled, 'Explicit production config enables receiver');
for (const overrides of [{ TELNYX_VOICE_HISTORY_ENABLED: 'false' }, { VERCEL_ENV: 'preview' }, { VERCEL_TARGET_ENV: 'preview' },
  { TELNYX_VOICE_CONNECTION_IDS: '' }, { TELNYX_VOICE_CONNECTION_IDS: '123,all' }, { TELNYX_PUBLIC_KEY: '' }]) {
  check(!voiceConfig({ ...env, ...overrides }).enabled, 'Receiver defaults closed');
  check((await webhook(database(), form(), { env: overrides })).code === 503, 'Disabled receiver never acknowledges persistence');
}
const raw = rawForm(form());
check(verifyVoiceSignature(raw, headers(raw), publicKey, now), 'Exact raw-body signature verified');
check(!verifyVoiceSignature(Buffer.concat([raw, Buffer.from('x')]), headers(raw), publicKey, now), 'Tampered payload rejected');
check(!verifyVoiceSignature(raw, headers(raw, String(now / 1000 - 301)), publicKey, now), 'Stale signatures rejected');
check(!verifyVoiceSignature(raw, headers(raw, String(now / 1000 + 301)), publicKey, now), 'Future signatures rejected');
check(!verifyVoiceSignature(raw, { ...headers(raw), 'telnyx-timestamp': ['123'] }, publicKey, now), 'Duplicate signature headers rejected');
const db = database();
check((await webhook(db)).code === 200, 'Initiated event durable');
await Promise.all(Array.from({ length: 8 }, () => webhook(db)));
check(db.tables.activity_logs.length === 1, 'Concurrent retries create one event');
check(db.tables.operations_cases.length === 0 && db.tables.notification_log.length === 0, 'Immediate hangup creates no Case or notification');
check(db.tables.activity_logs[0].metadata.callReference === ref, 'Same reference as confirmed intake');
check((await webhook(db, form(), { headers: { 'telnyx-signature-ed25519': 'bad' } })).code === 401, 'Unsigned call rejected');
check((await webhook(db, form({ ConnectionId: '999' }))).code === 403, 'Wrong connection rejected');
check((await webhook(db, form(), { method: 'GET' })).code === 405, 'Webhook method protected');
check((await webhook(db, form(), { raw: Buffer.alloc(32769) })).code === 413, 'Body size bound');
check((await webhook(db, form(), { headers: { 'content-type': 'text/plain' } })).code === 415, 'Unknown format rejected');
check((await webhook(database({}, { write: true }))).code === 503, 'Failed persistence causes provider retry');
for (const bad of [{ CallSid: '' }, { Timestamp: 'invalid' }, { Timestamp: '2099-01-01T00:00:00Z' }, { SequenceNumber: '-1' },
  { CallStatus: 'invented' }, { CallbackSource: 'other' }, { CallControlId: 'v3:different_provider_12345' }]) {
  check((await webhook(db, form(bad))).code === 400, 'Malformed signed form rejected');
}
check((await webhook(db, form(), { raw: Buffer.from(rawForm(form()).toString() + '&CallStatus=completed') })).code === 400, 'Ambiguous duplicate form field rejected');
const privateFields = parseForm(form({ From: 'sip:secret@private.example', RecordingUrl: 'https://secret.example',
  TranscriptionText: 'private transcript', client_state: 'secret', Digits: 'private-card', CallerName: 'unverified person',
  CallSessionId: 'test-session-abc123', ParentCallSid: 'v3:parent_call_1234567890' }));
check(privateFields.metadata.from === null, 'SIP URI never persisted');
check(!JSON.stringify(privateFields).includes('secret') && !JSON.stringify(privateFields).includes('private transcript') && !JSON.stringify(privateFields).includes('private-card'), 'Sensitive payload fields dropped');
check(privateFields.metadata.sessionReference.startsWith('session_') && privateFields.metadata.parentCallReference.startsWith('call_'), 'Relationships hashed');
for (const status of ['initiated', 'ringing', 'in-progress', 'completed', 'busy', 'no-answer', 'canceled', 'failed']) {
  check(parseForm(form({ CallStatus: status })).metadata.status === status, 'TeXML ' + status);
}
for (const type of ['call.initiated', 'call.answered', 'call.hangup']) {
  const json = Buffer.from(JSON.stringify(jsonEvent(type)));
  const out = await webhook(db, null, { raw: json, headers: { 'content-type': 'application/json' } });
  check(out.code === 200, 'Voice API ' + type);
}
check((await webhook(db, null, { raw: Buffer.from(JSON.stringify(jsonEvent('call.speak.ended'))), headers: { 'content-type': 'application/json' } })).data.ignored, 'Unrelated JSON events safely ignored after authentication');
check((await webhook(db, null, { raw: Buffer.from('{broken'), headers: { 'content-type': 'application/json' } })).code === 400, 'Malformed JSON rejected');
const started = parseForm(form());
const ended = parseForm(form({ CallStatus: 'completed', SequenceNumber: '2', Timestamp: new Date(now - 1000).toISOString(), CallDuration: '9' }));
const answeredLate = parseForm(form({ CallStatus: 'in-progress', SequenceNumber: '1', Timestamp: new Date(now - 5000).toISOString() }), now + 1000);
const projected = projectVoiceCall([ended, answeredLate, started]);
check(projected.status === 'completed' && projected.durationSeconds === 9, 'Late answer cannot reopen terminal call');
check(projectVoiceCall([started]).status === 'initiated', 'Initiated-only remains known, not falsely missed');
check(projectVoiceCall([ended]).status === 'completed', 'End-only call visible');
check(projectVoiceCall([ended, parseForm(form({ CallStatus: 'failed', SequenceNumber: '3' }))]).status === 'conflicting', 'Contradictory terminal outcomes flagged');
check(projectVoiceCall([ended], null, false).status === 'incomplete', 'Truncation never gives authoritative outcome');
check(projectVoiceCall([ended, ended]).events.length === 1, 'Projection deduplicates IDs');
check(parseForm(form({ From: '+15125550101', To: '+15125550100' })).metadata.direction === 'outbound', 'Owned outbound leg classified');
check(parseForm(form({ From: '+15125550102', To: '+15125550103' })).metadata.direction === 'unknown', 'Unknown direction not guessed');

const ownerDb = database({ activity_logs: [started, ended, answeredLate] });
let out = await owner(ownerDb);
check(out.code === 200 && out.data.calls.length === 1, 'Owner sees one call for three lifecycle events');
check(out.data.calls[0].requestState === 'none_found' && out.data.calls[0].identityVerified === false, 'No intake and no identity inferred');
check(out.data.calls[0].callbackConsent === null, 'Call history never supplies truthy callback consent');
check(out.data.calls[0].notificationState === 'not_applicable' && out.data.unreviewed === 1, 'Abandoned call has owner indicator, not callback email');
check((await owner(ownerDb, {}, { authorized: false })).code === 401, 'Customers and Easers cannot access owner calls');
check((await owner(ownerDb, {}, { method: 'POST', authorized: false })).code === 401, 'Unauthorized review cannot mutate');
check((await owner(ownerDb, {}, { method: 'DELETE' })).code === 405, 'No deletion route');
check((await owner(ownerDb, { reference: 'anything' })).code === 400, 'Owner query validated');
check((await owner(ownerDb, { cursor: Buffer.from(JSON.stringify({ at: 'or.inject', id: randomUUID() })).toString('base64url') })).code === 400, 'Cursor injection rejected');
check((await owner(ownerDb, {}, { env: { TELNYX_VOICE_HISTORY_ENABLED: 'false' } })).data.enabled === false, 'Disabled capture still exposes retained history honestly');
check((await owner(database({}, { activity_logs: true }))).code === 503, 'History outage not empty history');
out = await owner(database({ activity_logs: [started] }, { operations_cases: true }));
check(out.data.calls[0].requestState === 'unavailable', 'Case read failure not no request');
const savedCase = { id: randomUUID(), source: 'system', source_ref: 'telnyx-ai:' + ref, case_ref: 'AAE-AI-TEST', status: 'open', severity: 'normal', subject: 'TEST request' };
const linkedDb = database({ activity_logs: [ended], operations_cases: [savedCase], notification_log: [{ id: randomUUID(), operation_case_id: savedCase.id,
  recipient_type: 'owner', notification_type: 'ai_customer_intake_owner', status: 'sent', sent_at: new Date(now).toISOString() }] });
out = await owner(linkedDb);
check(out.data.calls[0].requestState === 'saved' && out.data.calls[0].cases[0].ref === savedCase.case_ref, 'Confirmed customer Case linked by exact provider reference');
check(out.data.calls[0].notificationState === 'delivery_unconfirmed', 'Sent is not delivered');
linkedDb.tables.notification_log[0].delivered_at = new Date(now).toISOString();
check((await owner(linkedDb)).data.calls[0].notificationState === 'delivered', 'Delivery evidence respected');
linkedDb.tables.notification_log[0].bounced_at = new Date(now).toISOString();
check((await owner(linkedDb)).data.calls[0].notificationState === 'needs_attention', 'Bounce wins over prior delivery');
check((await owner(database(linkedDb.tables, { notification_log: true }))).data.calls[0].notificationState === 'unavailable', 'Notification outage explicit');
linkedDb.tables.notification_log[0].notification_type = 'ai_pro_support_owner';
check((await owner(linkedDb)).data.calls[0].cases.length === 1, 'Easer support same source-of-truth link');

const revision = projected.revision;
check((await owner(ownerDb, {}, { method: 'POST', body: { action: 'review', reference: ref, revision: '0'.repeat(64) } })).code === 409, 'Stale review rejected');
check((await owner(ownerDb, {}, { method: 'POST', body: { action: 'review', reference: ref, revision } })).code === 200, 'Exact observed activity can be reviewed');
check((await owner(ownerDb)).data.unreviewed === 0, 'Review clears call indicator');
check(ownerDb.writes.every(w => w.table === 'activity_logs' && w.row.event_type === VOICE_REVIEW), 'Review never contacts caller or mutates Case');
ownerDb.tables.activity_logs.push(parseForm(form({ CallStatus: 'ringing', SequenceNumber: '4' }), now + 2000));
check((await owner(ownerDb)).data.unreviewed === 1, 'Late new event reopens review indicator');
check((await owner(database(ownerDb.tables, { write: true }), {}, { method: 'POST', body: {
  action: 'review', reference: ref, revision: projectVoiceCall(ownerDb.tables.activity_logs).revision } })).code === 503, 'Review write failure not acknowledged');

const many = Array.from({ length: 85 }, (_, i) => parseForm(form({ CallSid: `v3:fictional_pagination_${String(i).padStart(5, '0')}` }), now));
const pagedDb = database({ activity_logs: many });
out = await owner(pagedDb);
check(out.data.calls.length === 80 && out.data.nextCursor, 'First page bounded with explicit continuation');
const next = await owner(pagedDb, { cursor: out.data.nextCursor });
check(next.data.calls.length === 5 && !next.data.nextCursor, 'Timestamp-plus-ID cursor handles equal receipt timestamps');
check(!next.data.calls.some(c => out.data.calls.some(first => first.reference === c.reference)), 'No skipped or duplicated calls across tied page boundary');
const overLimit = Array.from({ length: 501 }, (_, i) => parseForm(form({ SequenceNumber: String(i) }), now));
const limited = await owner(database({ activity_logs: overLimit }), { reference: ref });
check(limited.data.call.complete === false && limited.data.call.status === 'incomplete', 'Detail limit explicit');
check((await owner(database({ activity_logs: overLimit }), {}, { method: 'POST', body: { action: 'review', reference: ref, revision: limited.data.call.revision } })).code === 409, 'Partial history cannot clear review');

// Execute the real browser module with a minimal DOM. No network or live records.
const script = await readFile(new URL('../owner/assets/voice-calls.js', import.meta.url), 'utf8');
const nodes = new Map(); const listeners = {}; let fixture = (await owner(linkedDb)).data;
const node = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', style: {}, hidden: false, disabled: false }); return nodes.get(id); };
const context = { console, Date, Map, URLSearchParams, encodeURIComponent,
  document: { hidden: false, getElementById: node, addEventListener(type, fn) { listeners[type] = fn; }, querySelector() { return null; } },
  window: { _ownerHeaders: () => ({ Authorization: 'Bearer fictional' }), setInterval() {} },
  fetch: async url => ({ ok: true, json: async () => url.includes('reference=') ? { call: fixture.calls[0] } : fixture }),
};
vm.runInNewContext(script, context);
await context.window.OwnerVoiceCalls.load();
check(node('voice-calls-detail').innerHTML.includes('Caller ID is unverified'), 'Owner sees identity limitation');
check(node('voice-calls-detail').innerHTML.includes('Open this Case'), 'Exact Case action rendered');
check(node('voice-calls-detail').innerHTML.includes('sends nothing'), 'Review action explains consent boundary');
fixture.calls[0].cases[0].subject = '<img src=x onerror=alert(1)>';
await context.window.OwnerVoiceCalls.load();
check(!node('voice-calls-detail').innerHTML.includes('<img src=x') && node('voice-calls-detail').innerHTML.includes('&lt;img'), 'Case content HTML escaped');
fixture.enabled = false;
await context.window.OwnerVoiceCalls.loadBadge();
check(node('nav-voice-calls').textContent === '!', 'Disabled capture never hides behind zero badge');
context.fetch = async () => { throw new Error('Fictional unavailable data'); };
await context.window.OwnerVoiceCalls.load();
check(node('voice-calls-notice').textContent.includes('may be stale'), 'UI error marks old data stale');
const html = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
check(html.includes('id="voice-calls-view"') && html.includes('data-view="voice-calls"') && html.includes('OwnerVoiceCalls.refresh()'), 'Owner navigation and refresh wired');
check(html.includes('/owner/assets/voice-calls.css') && html.includes('/owner/assets/voice-calls.js'), 'Assets loaded');
check(!(await readFile(new URL('../api/webhooks/telnyx-voice.js', import.meta.url), 'utf8')).includes('createOperationCase'), 'Webhook has no Case creation dependency');
check(voiceRowId('review:' + ref) !== ended.id, 'Review row cannot overwrite event row');
const browserLint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ['**/*.js'], languageOptions: {
  ecmaVersion: 2023, sourceType: 'script', globals: globals.browser }, rules: { 'no-undef': 'error', 'no-redeclare': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error' } }] });
for (const file of ['voice-calls.js', 'cases.js']) {
  const source = await readFile(new URL('../owner/assets/' + file, import.meta.url), 'utf8');
  const lint = await browserLint.lintText(source, { filePath: 'owner/assets/' + file });
  check(lint.every(r => r.errorCount === 0), file + ' browser scope lint: ' + JSON.stringify(lint.flatMap(r => r.messages)));
}
console.log(`PASS: ${checks} phone-history checks. Fake data only; no live calls, messages, records, or payment changes.`);
