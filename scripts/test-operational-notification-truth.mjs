import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as appointments from '../api/booking/_appt-date.js';
import { BOOKING_STATUS } from '../api/_source-of-truth.js';
import { notificationDeliveryKey } from '../api/_notification-policy.js';

// Execute the real cron handlers against an in-memory PostgREST boundary.
// No provider, database, or production network call is made.
const sources = Object.fromEntries(await Promise.all(['unassigned-escalation', 'no-show-check', 'easer-arrival-nudge'].map(async name => [name, await readFile(new URL(`../api/cron/${name}.js`, import.meta.url), 'utf8')])));
const fixture = () => ({ id: 'booking-1', ref: 'AAE-TEST', service: 'Furniture Assembly', date: '2026-09-24', time: '9:00 AM - 11:00 AM', service_zip: '78701', status: 'confirmed', customer_name: 'Client', customer_email: 'client@example.test', assembler_id: 'easer-1', assembler_name: 'Easer', assembler_accepted_at: '2026-09-23T15:00:00Z', checked_in_at: null, arrival_nudge_count: 0, arrival_nudge_sent_at: null, unassigned_customer_notified_at: null, unassigned_escalated_at: null });

function harness(name, booking = fixture(), options = {}) {
  const data = { bookings: [booking], profiles: [{ id: 'easer-1', phone: '+15125550101', sms_consent_at: '2026-01-01', sms_opted_out_at: null }], notification_log: [] };
  const calls = { email: [], push: [], sms: [], activity: [], updates: [], cron: [] };
  let now = Date.parse(options.now || '2026-09-24T14:35:00Z');
  const keys = new Map();
  const inFlight = new Set();
  const leases = new Set();
  let readCount = 0;
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.maximum = Infinity; }
    select() { return this; }
    or() { this.filters.push(row => row.return_visit_required !== true); return this; }
    update(patch) { this.patch = patch; return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    is(key, value) { this.filters.push(row => (row[key] ?? null) === value); return this; }
    not(key, _op, value) { this.filters.push(row => (row[key] ?? null) !== value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
    limit(value) { this.maximum = value; return this; }
    order(key, { ascending }) { this.sorter = (a, b) => (a[key] > b[key] ? 1 : -1) * (ascending ? 1 : -1); return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (this.table === 'bookings' && !this.patch) {
          readCount++;
          options.beforeBookingRead?.(readCount, booking);
        }
        let rows = (data[this.table] || []).filter(row => this.filters.every(f => f(row)));
        if (this.sorter) rows.sort(this.sorter);
        rows = rows.slice(0, this.maximum);
        if (this.patch) {
          calls.updates.push(structuredClone(this.patch));
          const error = options.updateError?.(this.patch);
          if (error) return { data: null, error: { message: error } };
          rows.forEach(row => Object.assign(row, this.patch));
        }
        const copied = structuredClone(rows);
        return { data: this.single ? copied[0] || null : copied, error: null };
      }).then(resolve, reject);
    }
  }
  const sb = { from: table => new Query(table) };
  const logSent = (channel, args) => data.notification_log.push({ id: 'log-' + data.notification_log.length, channel, booking_id: booking.id, notification_type: args.meta.notificationType, recipient_type: args.meta.recipientType, recipient_user_id: args.meta.recipientUserId, status: 'sent', subject: args.subject, sent_at: new Date(now).toISOString() });
  async function email(args) {
    const key = args.meta.notificationKey;
    if (keys.has(key)) return { ok: true, suppressed: true, sentAt: keys.get(key) };
    if (inFlight.has(key)) return { ok: false, deferred: true };
    inFlight.add(key);
    calls.email.push(args);
    await Promise.resolve();
    const result = options.emailResult?.(args, calls.email.length) || { ok: true };
    if (result.ok) { keys.set(key, new Date(now).toISOString()); logSent('email', args); }
    inFlight.delete(key);
    return { ...result, ...(result.ok ? { sentAt: new Date(now).toISOString() } : {}) };
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    Date: Clock, console, process: { env: { CRON_SECRET: 'test-secret' } }, BOOKING_STATUS,
    getSupabase: () => sb, sendEmail: email, ownerEmail: () => 'owner@example.test', esc: String,
    notificationDeliveryKey,
    formatAddress: () => 'Austin, TX', formatUsPhone: value => value,
    ...appointments,
    notificationAppointmentTimestampMs: appointments.notificationAppointmentTimestampMs || (b => appointments.appointmentTimestampMs(b.date, b.time)),
    appointmentTimeZone: appointments.appointmentTimeZone || (() => 'America/Chicago'),
    logActivity: async (_sb, event) => { calls.activity.push(event); return { ok: true }; },
    logCron: async (_name, event) => { calls.cron.push(event); },
    acquireNotificationLease: async (_sb, key) => { if (leases.has(key)) return { ok: false, reason: 'busy' }; leases.add(key); return { ok: true, token: key }; },
    releaseNotificationLease: async (_sb, key) => leases.delete(key),
    sendPushToUser: async (id, payload, meta) => {
      calls.push.push({ id, payload, meta });
      const result = options.pushResult?.() || { ok: true };
      if (result.ok) logSent('push', { subject: payload.title, meta: { ...meta, recipientUserId: id } });
      return result;
    },
    sendSms: async args => {
      calls.sms.push(args);
      const result = options.smsResult?.() || { ok: true };
      if (result.ok) data.notification_log.push({ notification_key: notificationDeliveryKey('sms', `user:${args.recipient.id}`, args.meta.notificationKey), status: 'provider_accepted', sent_at: new Date(now).toISOString() });
      return result;
    },
  });
  const source = sources[name].replace(/^import .*;\r?\n/gm, '').replace('export default async function handler', 'async function handler').replace(/export function /g, 'function ');
  vm.runInContext(source + '\nglobalThis.handler = handler;', context);
  const run = async () => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await context.handler({ headers: { authorization: 'Bearer test-secret' } }, response);
    return response;
  };
  return { run, calls, booking, data, advance: minutes => { now += minutes * 60000; } };
}

{
  let rejectCustomer = true;
  const h = harness('unassigned-escalation', { ...fixture(), assembler_accepted_at: null }, { now: '2026-09-24T13:00:00Z', emailResult: args => args.meta.recipientType === 'customer' && rejectCustomer ? { ok: false, error: 'provider rejected' } : { ok: true } });
  await h.run();
  assert.equal(h.booking.unassigned_customer_notified_at, null);
  assert.equal(h.calls.activity.some(a => a.eventType === 'unassigned_customer_notified'), false);
  assert.match(h.calls.email.find(a => a.meta.recipientType === 'owner').subject, /CONTACT NEEDED/);
  rejectCustomer = false;
  await h.run();
  assert.ok(h.booking.unassigned_customer_notified_at);
  const sent = h.calls.email.length;
  await h.run();
  assert.equal(h.calls.email.length, sent, 'successful staffing notices must not repeat');
}
{
  let failOwner = true;
  const h = harness('unassigned-escalation', { ...fixture(), assembler_accepted_at: null }, { now: '2026-09-24T10:00:00Z', emailResult: () => ({ ok: !failOwner }) });
  await h.run();
  assert.equal(h.booking.unassigned_escalated_at, null, 'failed sourcing alert never gets a success stamp');
  failOwner = false;
  await h.run();
  assert.ok(h.booking.unassigned_escalated_at);
}
{
  let failOwner = true;
  const h = harness('unassigned-escalation', { ...fixture(), assembler_accepted_at: null }, { now: '2026-09-24T13:00:00Z', emailResult: args => ({ ok: args.meta.recipientType === 'customer' || !failOwner }) });
  await h.run(); failOwner = false; await h.run();
  assert.equal(h.calls.email.filter(a => a.meta.recipientType === 'customer').length, 1, 'owner retry must not repeat customer notice');
  assert.equal(h.calls.email.filter(a => a.meta.recipientType === 'owner').length, 2);
}
{
  const h = harness('unassigned-escalation', { ...fixture(), assembler_accepted_at: null }, { now: '2026-09-24T13:00:00Z' });
  await Promise.all([h.run(), h.run()]);
  assert.equal(h.calls.email.filter(a => a.meta.recipientType === 'customer').length, 1, 'same event key protects overlapping cron runs');
}
{
  let fail = true;
  const h = harness('no-show-check', fixture(), { now: '2026-09-24T15:05:00Z', emailResult: () => ({ ok: !fail }) });
  await h.run();
  assert.equal(h.calls.activity.some(a => a.eventType === 'no_show_flagged'), false);
  fail = false; await h.run(); await h.run();
  assert.equal(h.calls.email.length, 2);
  assert.equal(h.calls.activity.filter(a => a.eventType === 'no_show_flagged').length, 1);
}
{
  const h = harness('no-show-check', fixture(), { now: '2026-09-24T15:05:00Z', beforeBookingRead: (n, b) => { if (n === 2) b.status = 'cancelled'; } });
  await h.run();
  assert.equal(h.calls.email.length, 0, 'cancellation after scan wins');
}
{
  const h = harness('easer-arrival-nudge');
  await h.run();
  assert.equal(h.booking.arrival_nudge_count, 1);
  h.advance(15); await h.run();
  assert.equal(h.calls.push.length, 1, 'delayed first run must not compress second nudge to 15 minutes');
  h.advance(15); await h.run();
  assert.equal(h.booking.arrival_nudge_count, 2);
  h.advance(45); await h.run();
  assert.equal(h.calls.push.length, 2, 'two successful nudges maximum');
  assert.equal(h.calls.sms.length, 0, 'push success does not also text');
}
{
  let fail = true;
  const h = harness('easer-arrival-nudge', fixture(), { pushResult: () => ({ ok: false }), smsResult: () => ({ ok: !fail }) });
  await h.run();
  assert.equal(h.booking.arrival_nudge_count, 0);
  assert.equal(h.booking.arrival_nudge_sent_at, null);
  assert.equal(h.calls.activity.some(a => a.eventType === 'arrival_nudge_sent'), false);
  fail = false; await h.run();
  assert.equal(h.booking.arrival_nudge_count, 1);
  assert.equal(h.calls.sms[0].meta.expiresAt, '2026-09-24T20:00:00.000Z', 'fallback must expire at the same six-hour stale cutoff as the cron');
}
{
  const h = harness('easer-arrival-nudge');
  await Promise.all([h.run(), h.run()]);
  assert.equal(h.calls.push.length, 1, 'workflow lease serializes push and SMS fallback');
}
{
  const h = harness('easer-arrival-nudge', fixture(), { beforeBookingRead: (n, b) => { if (n === 2) { b.status = 'arrived'; b.checked_in_at = '2026-09-24T14:34:00Z'; } } });
  await h.run();
  assert.equal(h.calls.push.length + h.calls.sms.length, 0);
}
for (const status of ['arrived', 'completed', 'cancelled']) {
  const h = harness('easer-arrival-nudge', { ...fixture(), status });
  await h.run();
  assert.equal(h.calls.push.length + h.calls.sms.length, 0);
}
{
  let failWrite = true;
  const h = harness('easer-arrival-nudge', fixture(), { updateError: patch => patch.arrival_nudge_count && failWrite ? 'counter write failed' : null });
  await h.run();
  assert.equal(h.booking.arrival_nudge_count, 0);
  failWrite = false; await h.run();
  assert.equal(h.booking.arrival_nudge_count, 1, 'recover a successful push after failed counter persistence');
  assert.equal(h.calls.push.length, 1, 'recovery must not repeat the push');
}
{
  let failWrite = true;
  let pushEnabled = false;
  const h = harness('easer-arrival-nudge', fixture(), {
    pushResult: () => ({ ok: pushEnabled }),
    updateError: patch => patch.arrival_nudge_count && failWrite ? 'counter write failed after SMS' : null,
  });
  await h.run();
  assert.equal(h.booking.arrival_nudge_count, 0);
  failWrite = false; pushEnabled = true; await h.run();
  assert.equal(h.booking.arrival_nudge_count, 1);
  assert.equal(h.calls.sms.length, 1, 'successful SMS must not repeat after lost counter write');
  assert.equal(h.calls.push.length, 1, 'newly enabled push must not duplicate that successful SMS');
}
{
  const h = harness('easer-arrival-nudge', { ...fixture(), status: 'en_route' });
  await h.run();
  assert.equal(h.calls.push.length, 1, 'en-route Easer also needs an arrival check-in');
  for (const patch of h.calls.updates) {
    assert.deepEqual(Object.keys(patch).sort(), ['arrival_nudge_count', 'arrival_nudge_sent_at'], 'nudge must never change booking/payment/arrival truth');
  }
}
for (const changes of [
  { arrival_nudge_count: 1, arrival_nudge_sent_at: null },
  { arrival_nudge_count: 1, arrival_nudge_sent_at: 'invalid' },
  { assembler_accepted_at: null },
  { return_visit_required: true },
]) {
  const h = harness('easer-arrival-nudge', { ...fixture(), ...changes });
  await h.run();
  assert.equal(h.calls.push.length, 0, 'missing acceptance or send history never authorizes another nudge');
}
{
  const h = harness('easer-arrival-nudge', fixture(), { now: '2026-09-24T20:01:00Z' });
  await h.run();
  assert.equal(h.calls.push.length, 0, 'stale appointment goes to owner intervention');
}
// A new appointment/recipient must not inherit the previous two-nudge budget.
for (const path of ['api/booking/reschedule.js', 'api/booking/assign.js', 'api/booking/_dispatch-internal.js']) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(source, /arrival_nudge_count: 0/);
  assert.match(source, /arrival_nudge_sent_at: null/);
}
console.log('PASS staffing retries, truthful owner outcomes, overlap protection, no-show recovery, arrival spacing/max2, state-change stops and push/SMS fallback.');
