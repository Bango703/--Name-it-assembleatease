import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

// Exercise the real handler, Ed25519 verifier and Supabase query builder.
// All HTTP is intercepted; these tests cannot send SMS or touch live data.
process.env.SUPABASE_URL = 'https://telnyx-unit.invalid';
process.env.SUPABASE_SERVICE_KEY = 'unit-test-placeholder';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

const tables = { profiles: [], bookings: [], notification_log: [] };
let failNext = null;
let requests = 0;
let outboundRequests = 0;
function condition(row, expression) {
  const [, column, op, value] = expression.match(/^([^.]+)\.(eq|is|in|lte|lt)\.(.*)$/) || [];
  if (!column) throw new Error(`Unsupported filter: ${expression}`);
  if (op === 'is') return value === 'null' && row[column] == null;
  if (op === 'eq') return String(row[column]) === value;
  if (op === 'in') return value.slice(1, -1).split(',').map(x => x.replace(/^"|"$/g, '')).includes(String(row[column]));
  if (row[column] == null) return false;
  return op === 'lt' ? row[column] < value : row[column] <= value;
}
function matches(row, params) {
  for (const [key, value] of params) {
    if (['select', 'limit', 'on_conflict'].includes(key)) continue;
    if (key === 'or') {
      if (!value.slice(1, -1).split(',').some(part => condition(row, part))) return false;
    } else if (!condition(row, `${key}.${value}`)) return false;
  }
  return true;
}
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.href === 'https://api.telnyx.com/v2/messages') {
    outboundRequests++;
    assert.equal(options.method, 'POST');
    return Response.json({ data: { id: 'mock-outbound-message' } });
  }
  assert.equal(url.origin, 'https://telnyx-unit.invalid', 'All tests must stay off the network');
  requests++;
  const table = url.pathname.split('/').at(-1);
  assert.ok(Object.hasOwn(tables, table));
  const method = options.method || 'GET';
  if (failNext?.table === table && failNext.method === method) {
    failNext = null;
    return Response.json({ message: 'Simulated database failure', code: 'XX000' }, { status: 500 });
  }
  const rows = tables[table].filter(row => matches(row, url.searchParams));
  if (method === 'POST') {
    const row = JSON.parse(options.body);
    const existing = tables[table].find(item => item.id === row.id);
    const preference = new Headers(options.headers).get('Prefer') || '';
    if (!existing) tables[table].push(row);
    else if (!preference.includes('resolution=ignore-duplicates')) Object.assign(existing, row);
    return new Response(null, { status: 201 });
  }
  if (method === 'PATCH') rows.forEach(row => Object.assign(row, JSON.parse(options.body)));
  assert.ok(['GET', 'PATCH'].includes(method));
  return Response.json(rows.map(row => ({ id: row.id })));
};
const { default: handler } = await import('../api/webhooks/telnyx.js');
const phone = '+15125550100';
const old = new Date(Date.now() - 120000).toISOString();
const later = new Date(Date.now() - 60000).toISOString();
const newest = new Date(Date.now() - 30000).toISOString();
function reset() {
  tables.profiles = [{ id: 'easer', phone, sms_consent_at: null, sms_opted_out_at: null }];
  tables.bookings = [{ id: 'booking', customer_phone: phone, sms_consent_at: null, sms_opted_out_at: null }];
  tables.notification_log = [];
  failNext = null;
}
function event(type, text = 'HELP', occurredAt = old, id = crypto.randomUUID()) {
  return { data: { event_type: type, occurred_at: occurredAt, id: crypto.randomUUID(), payload: {
    id, from: { phone_number: phone }, text, to: [{ status: 'delivered' }],
  } } };
}
async function deliver(body, { unsigned = false, expired = false, invalid = false } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000) - (expired ? 600 : 0));
  const signature = crypto.sign(null, Buffer.from(`${timestamp}|${raw}`), privateKey).toString('base64');
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = unsigned ? {} : {
    'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': invalid ? Buffer.alloc(64).toString('base64') : signature,
  };
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res);
  return res;
}

reset();
for (const options of [{ unsigned: true }, { expired: true }, { invalid: true }]) {
  const before = requests;
  assert.equal((await deliver(event('message.received'), options)).code, 400);
  assert.equal(requests, before, 'Untrusted events must never access the database');
}
console.log('PASS unsigned, expired and forged webhooks rejected before database access');

for (const table of ['profiles', 'bookings', 'notification_log']) {
  reset();
  failNext = { table, method: table === 'notification_log' ? 'POST' : 'PATCH' };
  const stop = event('message.received', 'STOP');
  assert.equal((await deliver(stop)).code, 503, `${table} failures must request retry`);
  assert.equal((await deliver(stop)).code, 200);
  assert.equal(tables.profiles[0].sms_opted_out_at, old);
  assert.equal(tables.bookings[0].sms_opted_out_at, old);
  assert.equal(tables.notification_log.length, 1);
}
console.log('PASS customer, Easer and inbox persistence failures retry successfully');

reset();
const help = event('message.received', 'HELP');
await Promise.all([deliver(help), deliver(help), deliver(help)]);
assert.equal(tables.notification_log.length, 1, 'Repeated inbound events must make one inbox entry');
assert.equal(tables.notification_log[0].recipient_email, phone);
assert.equal(tables.profiles[0].sms_consent_at, null, 'HELP is not consent');
console.log('PASS duplicate inbound replies deduplicated and HELP does not change consent');

reset();
await deliver(event('message.received', 'STOP', later));
await deliver(event('message.received', 'START', old));
assert.equal(tables.bookings[0].sms_opted_out_at, later, 'Old START must not undo a newer STOP');
await deliver(event('message.received', 'START', later));
assert.equal(tables.bookings[0].sms_opted_out_at, later, 'STOP must win an exact timestamp tie');
await deliver(event('message.received', 'START', newest));
await deliver(event('message.received', 'STOP', old));
for (const row of [tables.profiles[0], tables.bookings[0]]) {
  assert.equal(row.sms_opted_out_at, null);
  assert.equal(row.sms_consent_at, newest);
}
console.log('PASS out-of-order consent events preserve the latest customer and Easer choice');

reset();
await deliver(event('message.received', ' stop all ', old));
await deliver(event('message.received', 'YES', later));
for (const row of [tables.profiles[0], tables.bookings[0]]) {
  assert.equal(row.sms_opted_out_at, old, 'YES must not restore messaging consent');
  assert.equal(row.sms_consent_at, null);
}
await deliver(event('message.received', 'unstop', newest));
for (const row of [tables.profiles[0], tables.bookings[0]]) {
  assert.equal(row.sms_opted_out_at, null, 'UNSTOP must mirror the provider restart');
  assert.equal(row.sms_consent_at, newest);
}
console.log('PASS STOP ALL opts out, YES does not opt in, and UNSTOP restores consent');

reset();
const messageId = crypto.randomUUID();
const finalized = event('message.finalized', '', later, messageId);
assert.equal((await deliver(finalized)).code, 503, 'A receipt arriving before the send log must retry');
tables.notification_log.push({ id: 'outbound', provider_id: messageId, channel: 'sms', status: 'provider_accepted' });
failNext = { table: 'notification_log', method: 'PATCH' };
assert.equal((await deliver(finalized)).code, 503);
assert.equal((await deliver(finalized)).code, 200);
await deliver(event('message.sent', '', old, messageId));
await deliver(event('message.sent', '', newest, messageId));
assert.equal(tables.notification_log[0].status, 'delivered', 'Sent cannot downgrade delivered even with an anomalous later timestamp');
assert.equal(tables.notification_log[0].last_provider_event_at, later);
console.log('PASS early receipts retry and late sent events cannot downgrade delivery truth');

const failed = event('message.finalized', '', newest, messageId);
failed.data.payload.to[0].status = 'delivery_failed';
failed.data.payload.errors = [{ detail: 'Destination unreachable' }];
assert.equal((await deliver(failed)).code, 200);
await deliver(finalized);
assert.equal(tables.notification_log[0].status, 'failed');
assert.equal(tables.notification_log[0].error_text, 'Destination unreachable');
console.log('PASS newer delivery failures stay owner-visible when older events arrive');

const malformed = event('message.received');
delete malformed.data.occurred_at;
assert.equal((await deliver(malformed)).code, 400);
assert.equal((await deliver(event('unhandled.event'))).code, 200);

// A provider-accepted text must not be retried or make a booking fail merely
// because its audit write failed. The Supabase error must still be observable.
const { sendSms } = await import('../api/_sms.js');
process.env.TELNYX_API_KEY = 'unit-test-placeholder';
process.env.TELNYX_FROM_NUMBER = '+15125550101';
reset();
failNext = { table: 'notification_log', method: 'POST' };
const capturedErrors = [];
const originalError = console.error;
let sent;
try {
  console.error = (...args) => capturedErrors.push(args.join(' '));
  sent = await sendSms({ recipient: { phone, sms_consent_at: old }, body: 'Unit test only.' });
} finally {
  console.error = originalError;
}
assert.equal(sent.ok, true, 'A log failure must not change provider-accepted truth');
assert.equal(outboundRequests, 1, 'A log failure must not resend the SMS');
assert.ok(capturedErrors.some(line => line.includes('notification_log write failed:') && line.includes('Simulated database failure')));
console.log('PASS sender log failures are observable without duplicate texts or booking failures');
console.log('Telnyx webhook behavioral tests passed. No network requests were made.');
