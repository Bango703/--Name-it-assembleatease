import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cancelQueuedNotification } from '../api/_notification-policy.js';
import { smsEligibility } from '../api/_sms.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const source = (await readFile(new URL('../api/cron/notification-retries.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace('export const config', 'const config')
  .replace('export default async function handler', 'async function handler');
const instant = Date.now();
const iso = delta => new Date(instant + delta).toISOString();
const minute = 60000;

function database(initial) {
  const rows = structuredClone(initial), failures = new Map();
  const db = { rows, failures, reads: 0, from(table) {
    rows[table] ||= [];
    let op = 'select', patch, single = false, cap = Infinity;
    const tests = [];
    const query = {
      select() { return query; },
      eq(field, value) { tests.push(row => row[field] === value); return query; },
      in(field, values) { tests.push(row => values.includes(row[field])); return query; },
      not(field, op, value) { if (op === 'is') tests.push(row => row[field] != value); return query; },
      lte(field, value) { tests.push(row => row[field] != null && row[field] <= value); return query; },
      or(value) {
        assert.match(value, /^claim_expires_at\.is\.null,claim_expires_at\.lte\./);
        const end = value.split('claim_expires_at.lte.')[1];
        tests.push(row => row.claim_expires_at == null || row.claim_expires_at <= end);
        return query;
      },
      order() { return query; }, limit(value) { cap = value; return query; },
      maybeSingle() { single = true; return query; },
      update(value) { op = 'update'; patch = structuredClone(value); return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          db.reads++;
          const failure = failures.get(`${table}:${op}`);
          if (failure) return { data: null, error: { message: failure } };
          const data = rows[table].filter(row => tests.every(test => test(row))).slice(0, cap);
          if (op === 'update') data.forEach(row => Object.assign(row, patch));
          return { data: structuredClone(single ? data[0] || null : data), error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
  return db;
}

const customer = { id: 'booking-1', customer_phone: '+15125550123', customer_email: 'customer@example.com', sms_consent_at: iso(-minute), sms_opted_out_at: null };
function notification(overrides = {}) {
  const row = {
    id: 'notice-1', channel: 'email', booking_id: 'booking-1', recipient_type: 'customer', recipient_email: customer.customer_email,
    notification_type: 'reminder', status: 'deferred', next_attempt_at: iso(-minute), send_expires_at: iso(10 * minute), claim_expires_at: null,
    send_payload: { kind: 'email', original: { to: customer.customer_email, subject: 'Your appointment', html: '<p>Details</p>' }, meta: { bookingId: 'booking-1', notificationKey: 'stable-key' } },
    ...overrides,
  };
  if (row.channel === 'sms') row.send_payload = { kind: 'sms', body: { to: customer.customer_phone }, original: { body: 'Appointment reminder' }, meta: { bookingId: 'booking-1', notificationKey: 'stable-sms' } };
  return row;
}
process.env.CRON_SECRET = 'notification-worker-offline-test';
const req = { method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
const response = () => ({ statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

async function harness({ notices = [notification()], bookings = [customer], profiles = [], eligibility = { ok: true }, outcome = { ok: true }, customize = () => {} } = {}) {
  const db = database({ notification_log: notices, bookings, profiles });
  const calls = { email: [], sms: [], eligibility: 0, logs: [] };
  let clock = instant;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const deps = {
    Date: Clock, getSupabase: () => db, cancelQueuedNotification, smsEligibility,
    notificationRetryEligibility: async () => { calls.eligibility++; return eligibility; },
    sendEmail: async message => { calls.email.push(message); return outcome; },
    sendSms: async message => { calls.sms.push(message); return outcome; },
    logCron: async (name, data) => { calls.logs.push({ name, ...data }); },
  };
  const setClock = value => { clock = value; };
  customize({ db, calls, deps, setClock });
  const handler = await new AsyncFunction(...Object.keys(deps), `${source}\nreturn handler;`)(...Object.values(deps));
  const res = response(); await handler(req, res);
  return { db, calls, res, handler };
}

// A provider retry reuses the exact original request and stable identity.
{
  const h = await harness();
  assert.equal(h.res.body.accepted, 1);
  assert.equal(h.calls.email[0].meta.notificationKey, 'stable-key');
  assert.equal(h.calls.email[0].html, '<p>Details</p>');
  assert.equal(h.calls.logs[0].records, 1);
  assert.equal(h.res.body.errors.length, 0);
  const before = h.db.reads;
  const unauthorized = response(); await h.handler({ ...req, headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401); assert.equal(h.db.reads, before);
  const wrongMethod = response(); await h.handler({ ...req, method: 'POST' }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405); assert.equal(h.db.reads, before);
}

// Current consent and destination always win over a stored send payload.
for (const overrides of [{}, { sms_consent_at: null }, { sms_opted_out_at: iso(-1000) }, { customer_phone: '+15125550124' }]) {
  const h = await harness({ notices: [notification({ channel: 'sms' })], bookings: [{ ...customer, ...overrides }] });
  const allowed = Object.keys(overrides).length === 0;
  assert.equal(h.calls.sms.length, allowed ? 1 : 0);
  assert.equal(h.res.body.accepted, allowed ? 1 : 0);
  assert.equal(h.res.body.cancelled, allowed ? 0 : 1);
  if (allowed) assert.equal(h.calls.sms[0].recipient.sms_consent_at, customer.sms_consent_at);
}
{
  const h = await harness({
    notices: [notification({ recipient_type: 'easer', recipient_user_id: 'easer-1', recipient_email: 'old@example.com' })],
    profiles: [{ id: 'easer-1', role: 'assembler', email: 'new@example.com' }],
  });
  assert.equal(h.calls.email.length, 0); assert.equal(h.res.body.cancelled, 1);
  assert.equal(h.db.rows.notification_log[0].send_payload, null);
}

// Retryable eligibility failures preserve the pending intent; permanent changes
// cancel it. A failed write cannot be counted as a successful cancellation.
{
  const h = await harness({ eligibility: { ok: false, retryable: true, reason: 'preference_lookup_unavailable' } });
  assert.equal(h.res.body.deferred, 1); assert.equal(h.res.body.cancelled, 0);
  assert.equal(h.calls.email.length, 0);
  assert.equal(h.db.rows.notification_log[0].next_attempt_at, iso(15 * minute));
}
for (const operation of ['cancel', 'defer']) {
  const h = await harness({
    eligibility: { ok: false, retryable: operation === 'defer', reason: 'changed' },
    customize: ({ db }) => db.failures.set('notification_log:update', 'write failed'),
  });
  assert.equal(h.res.body.cancelled, 0); assert.equal(h.res.body.deferred, 0);
  assert.equal(h.res.body.errors.length, 1); assert.equal(h.calls.email.length, 0);
}
{
  const h = await harness({ notices: [notification({ status: 'queued', channel: 'sms' })] });
  assert.equal(h.res.body.uncertain, 1); assert.equal(h.res.body.cancelled, 0);
  assert.equal(h.calls.sms.length, 0); assert.equal(h.calls.eligibility, 0);
  assert.equal(h.db.rows.notification_log[0].status, 'uncertain');
  assert.equal(h.db.rows.notification_log[0].send_payload, null);
}
{
  const h = await harness({ notices: [notification({ status: 'queued', channel: 'sms', claim_expires_at: iso(minute) })] });
  assert.equal(h.res.body.uncertain, 0); assert.equal(h.res.body.cancelled, 0);
  assert.equal(h.res.body.errors.length, 1, 'an active provider claim cannot be overwritten');
  assert.equal(h.db.rows.notification_log[0].status, 'queued');
}
for (const status of ['deferred', 'queued']) {
  const h = await harness({ notices: [notification({ status, send_expires_at: iso(-minute) })], eligibility: { ok: false, retryable: true } });
  assert.equal(h.calls.eligibility, 0, 'expiry precedes eligibility outages');
  assert.equal(h.calls.email.length, 0);
  assert.equal(h.res.body[status === 'queued' ? 'uncertain' : 'cancelled'], 1);
}
{
  const h = await harness({ bookings: [] });
  assert.equal(h.res.body.cancelled, 1); assert.equal(h.calls.email.length, 0);
}

for (const outcome of [{ ok: false, error: 'provider rejection' }, { ok: false, deferred: true }, { ok: false, retryScheduled: true }]) {
  const h = await harness({ outcome });
  assert.equal(h.res.body.accepted, 0);
  assert.equal(h.res.body.deferred, outcome.deferred || outcome.retryScheduled ? 1 : 0);
  assert.equal(h.res.body.errors.length, outcome.error ? 1 : 0);
}
{
  const h = await harness({ notices: [notification({ channel: 'sms' })], outcome: { ok: false, uncertain: true, error: 'Provider outcome unknown' } });
  assert.equal(h.res.body.uncertain, 1, 'a newly uncertain provider attempt is visible in the same counter as a recovered ambiguous attempt');
  assert.equal(h.res.body.accepted, 0); assert.equal(h.res.body.cancelled, 0); assert.equal(h.res.body.deferred, 0);
  assert.equal(h.res.body.errors.length, 1, 'owner still receives the outcome detail');
}
{
  const h = await harness({ customize: ({ db }) => db.failures.set('notification_log:select', 'queue unavailable') });
  assert.equal(h.res.statusCode, 503); assert.equal(h.calls.email.length, 0);
}
{
  const notices = [notification(), notification({ id: 'notice-2' }), notification({ id: 'notice-3' })];
  const h = await harness({ notices, customize: ({ calls, deps, setClock }) => {
    deps.sendEmail = async message => { calls.email.push(message); setClock(instant + 36000); return { ok: true }; };
  } });
  assert.equal(h.calls.email.length, 1, 'do not start another provider request after the soft budget');
  assert.equal(h.res.body.accepted, 1);
}
{
  const notices = [notification(), notification({ id: 'notice-2' })];
  const h = await harness({ notices, customize: ({ calls, deps, setClock }) => {
    deps.notificationRetryEligibility = async () => { calls.eligibility++; setClock(instant + 36000); return { ok: false, reason: 'opted_out' }; };
  } });
  assert.equal(h.calls.eligibility, 1, 'continue branches obey the same time budget');
  assert.equal(h.res.body.cancelled, 1);
}

for (const outcome of [{ ok: true }, { ok: false, error: 'rejected' }]) {
  const notice = notification({ notification_type: 'dispatch_offer', recipient_user_id: 'easer-1' });
  notice.send_payload.meta.expiresAt = iso(10 * minute);
  const h = await harness({ notices: [notice], outcome, customize: ({ db }) => {
    db.rows.dispatch_offers = [
      { booking_id: 'booking-1', easer_id: 'easer-1', expires_at: iso(10 * minute), notification_sent: false },
      { booking_id: 'booking-1', easer_id: 'easer-1', expires_at: iso(20 * minute), notification_sent: false },
    ];
  } });
  assert.equal(h.db.rows.dispatch_offers[0].notification_sent, outcome.ok);
  assert.equal(h.db.rows.dispatch_offers[1].notification_sent, false, 'a retry cannot mark a different offer round');
}
console.log('Notification retry worker consent, recipient, eligibility, cancellation, and budget behavior: PASS');
