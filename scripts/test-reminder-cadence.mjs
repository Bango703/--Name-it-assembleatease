import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as dates from '../api/booking/_appt-date.js';
import * as email from '../api/_email.js';
import { smsEligibility } from '../api/_sms.js';
import { BOOKING_STATUS, isBookingPaymentReadyForDispatch } from '../api/_source-of-truth.js';
import { isOwnerManualLiveFlow } from '../api/_owner-easer.js';
import { operationalDate, operationalTime } from '../api/owner/_active-jobs.js';
import { guestManageUrl } from '../api/_payment-security.js';
import { notificationEventKey, notificationLocalHour } from '../api/_notification-policy.js';
import { reminderPurpose, reminderAppointment, buildReminderEmail } from '../api/cron/reminders.js';

const fixture = changes => ({ id: 'booking-1', ref: 'AAE-TEST', service: 'Outdoor & Playsets', customer_name: 'Customer', customer_email: 'customer@example.test', customer_phone: '+15125550100', sms_consent_at: '2026-09-01T12:00:00Z', sms_opted_out_at: null, status: 'confirmed', date: '2026-09-24', time: '10:00 AM - 12:00 PM', service_zip: '78701', reminder_sent: false, assembler_id: 'easer-1', assembler_accepted_at: '2026-09-22T12:00:00Z', created_at: '2026-09-20T12:00:00Z', payment_status: 'authorized', payment_authorized_at: '2026-09-22T12:00:00Z', stripe_payment_intent_id: 'pi_test', total_price: 20000, return_visit_required: false, ...changes });
const at = (time, booking = fixture(), role = 'customer') => reminderPurpose(booking, new Date(time), role);

assert.equal(at('2026-09-23T13:59:00Z'), null, 'no email before 9AM Central');
assert.equal(at('2026-09-23T14:00:00Z'), 'day_before');
assert.equal(at('2026-09-24T00:30:00Z'), 'day_before', 'UTC tomorrow is still prior local calendar day');
assert.equal(at('2026-09-24T01:00:00Z'), null, '8PM quiet-hours cutoff');
assert.equal(at('2026-09-24T13:00:00Z'), 'day_of', '10AM job gets an 8AM text');
assert.equal(at('2026-09-24T13:59:00Z'), 'day_of', 'hourly scan tolerates a sub-hour delay');
assert.equal(at('2026-09-24T14:00:00Z'), null, 'late scan must not text in final hour');
assert.equal(at('2026-09-24T13:00:00Z', fixture({ time: '9 AM-11 AM' })), null, '7AM due text is skipped, not shifted to 8AM');
assert.equal(at('2026-09-23T14:00:00Z', fixture({ time: '8 AM-10 AM' })), 'day_before', 'short-hour format in screenshot is supported');
assert.equal(at('2026-09-23T14:00:00Z', fixture({ service_zip: '79901' })), null, 'El Paso is still 8AM');
assert.equal(at('2026-09-23T15:00:00Z', fixture({ service_zip: '79901' })), 'day_before');
assert.equal(at('2026-09-24T14:00:00Z', fixture({ service_zip: '79901' })), 'day_of', 'El Paso local two-hour slot');
assert.equal(at('2026-11-01T15:00:00Z', fixture({ date: '2026-11-02', created_at: '2026-10-01', assembler_accepted_at: '2026-10-01' })), 'day_before', 'fall DST remains 9AM local');
assert.equal(at('2026-03-08T14:00:00Z', fixture({ date: '2026-03-09', created_at: '2026-03-01', assembler_accepted_at: '2026-03-01' })), 'day_before', 'spring DST remains 9AM local');
for (const changes of [{ is_test_booking: true }, { status: 'cancelled' }, { status: 'completed' }, { time: null }, { time: 'sometime' }]) {
  assert.equal(at('2026-09-23T14:00:00Z', fixture(changes)), null);
}
assert.equal(at('2026-09-23T14:00:00Z', fixture({ assembler_accepted_at: null }), 'easer'), null);
assert.equal(at('2026-09-23T14:00:00Z', fixture({ assembler_accepted_at: null }), 'customer'), 'day_before');
assert.equal(at('2026-09-23T14:00:00Z', fixture({ created_at: '2026-09-23T13:00:00Z' })), null, 'recent booking confirmation covers the details');
assert.equal(at('2026-09-23T14:00:00Z', fixture({ assembler_accepted_at: '2026-09-23T13:00:00Z' }), 'easer'), null);
const returnVisit = fixture({ date: '2026-09-20', return_visit_required: true, return_visit_date: '2026-09-24', return_visit_time: '2:00 PM - 4:00 PM', return_visit_scheduled_at: '2026-09-21T12:00:00Z', return_visit_remaining_scope: 'Finish the cabinet' });
assert.equal(reminderAppointment(returnVisit).date, '2026-09-24');
assert.equal(at('2026-09-23T14:00:00Z', returnVisit), 'day_before');
assert.equal(at('2026-09-23T14:00:00Z', { ...returnVisit, return_visit_date: null }), null, 'never fall back to old date for incomplete return-visit data');

for (const recipientType of ['customer', 'easer']) {
  const html = buildReminderEmail({ booking: fixture(), recipientType, firstName: '<Phil>' });
  assert.match(html, /Thursday, September 24, 2026/);
  assert.match(html, /Arrival window/);
  assert.match(html, /Central Time/);
  assert.match(html, /logo\.jpg/, 'actual branded email shell');
  assert.match(html, /&lt;Phil&gt;/);
  assert.match(html, recipientType === 'easer' ? /View job details/ : /View your booking/);
  assert.doesNotMatch(html, /Your (?:job|appointment) is tomorrow|at least 24 hours/, 'body stays calendar-specific and uses real booking terms');
}
assert.match(buildReminderEmail({ booking: returnVisit, recipientType: 'easer' }), /Remaining work/);

const source = (await readFile(new URL('../api/cron/reminders.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ').replace('export default async function handler', 'async function handler');
function harness({ booking = fixture(), now = '2026-09-23T14:00:00Z', outcome, legacy = [], easerChanges = {}, beforeRead } = {}) {
  let time = Date.parse(now);
  const log = legacy;
  const calls = [];
  const keys = new Map();
  const sending = new Set();
  const updates = [];
  let reads = 0;
  const profile = { id: 'easer-1', role: 'assembler', is_owner: false, full_name: 'Phil Example', email: 'easer@example.test', phone: '+15125550101', sms_consent_at: '2026-09-01', sms_opted_out_at: null, ...easerChanges };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; } order() { return this; } limit() { return this; } or() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    is(key, value) { this.filters.push(row => (row[key] ?? null) === value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
    maybeSingle() { this.single = true; return this; }
    update(patch) { this.patch = patch; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => {
      if (this.table === 'bookings' && !this.patch) beforeRead?.(++reads, booking);
      const rows = (this.table === 'bookings' ? [booking] : this.table === 'profiles' ? [profile] : []).filter(row => this.filters.every(f => f(row)));
      if (this.patch) { updates.push(this.patch); rows.forEach(row => Object.assign(row, this.patch)); }
      const copied = structuredClone(rows);
      return { data: this.single ? copied[0] || null : copied, error: null };
    }).then(resolve, reject); }
  }
  async function send(channel, args) {
    const key = channel + ':' + args.meta.notificationKey;
    const old = log.find(row => row.channel === channel && row.recipientType === args.meta.recipientType && row.sentAt >= args.meta.legacySince);
    if (keys.has(key) || old) return { ok: true, suppressed: true, logged: true };
    if (sending.has(key)) return { ok: false, deferred: true };
    sending.add(key); await Promise.resolve(); calls.push({ channel, ...args });
    const result = outcome?.(channel, args) || { ok: true, logged: true };
    if (result.ok) keys.set(key, true);
    sending.delete(key); return result;
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const context = vm.createContext({ Date: Clock, console, process: { env: { CRON_SECRET: 'secret' } }, ...dates, ...email,
    getSupabase: () => ({ from: table => new Query(table) }), sendEmail: args => send('email', args), sendSms: args => send('sms', args),
    smsEligibility, BOOKING_STATUS, isBookingPaymentReadyForDispatch, isOwnerManualLiveFlow, operationalDate, operationalTime, guestManageUrl,
    notificationEventKey, notificationLocalHour, logCron: async () => {}, ownerEmail: () => 'owner@example.test' });
  vm.runInContext(source + '\nglobalThis.handler = handler;', context);
  return { booking, calls, updates, advance: hours => { time += hours * 3600000; }, run: async () => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await context.handler({ headers: { authorization: 'Bearer secret' } }, res); assert.equal(res.code, 200, JSON.stringify(res.body)); return res.body;
  } };
}

{
  const h = harness(); await Promise.all([h.run(), h.run()]); h.advance(1); await h.run();
  assert.equal(h.calls.length, 2, 'one prior-day email each despite overlapping and hourly scans');
  assert.ok(h.calls.every(c => c.channel === 'email'));
  assert.equal(h.booking.reminder_sent, true);
  for (const patch of h.updates) assert.deepEqual(Object.keys(patch), ['reminder_sent'], 'notification cron changes no money or booking state');
}
for (const legacyChannels of [['sms'], ['email'], ['email', 'sms']]) {
  const h = harness({ legacy: legacyChannels.map(channel => ({ channel, recipientType: 'easer', sentAt: '2026-09-23T12:00:00Z' })) });
  await h.run(); h.advance(1); await h.run();
  assert.equal(h.calls.filter(c => c.meta.recipientType === 'easer').length, legacyChannels.includes('email') ? 0 : 1, 'prior SMS must not cause repeated reminder email');
}
{
  let fail = true;
  const h = harness({ outcome: (_channel, args) => args.meta.recipientType === 'customer' && fail ? { ok: false, error: 'rejected' } : { ok: true } });
  await h.run(); assert.equal(h.booking.reminder_sent, false);
  assert.equal(h.calls.filter(c => c.meta.recipientType === 'easer').length, 1, 'customer rejection never blocks Easer');
  fail = false; h.advance(1); await h.run();
  assert.equal(h.booking.reminder_sent, true);
  assert.equal(h.calls.filter(c => c.meta.recipientType === 'easer').length, 1);
}
{
  const h = harness({ outcome: () => ({ ok: false, deferred: true }) });
  const result = await h.run(); assert.equal(result.deferred, 2); assert.equal(h.booking.reminder_sent, false);
}
{
  const h = harness({ now: '2026-09-24T13:00:00Z' }); await h.run(); await h.run();
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(c => c.channel === 'sms'));
  assert.equal(h.booking.reminder_sent, false, 'SMS does not invent an email success');
  for (const call of h.calls) assert.ok((call.body + ' Reply STOP to opt out.').length <= 160, 'day-of SMS fits one GSM segment including opt-out');
}
{
  const h = harness({ now: '2026-09-24T13:00:00Z', booking: fixture({ sms_consent_at: null }), easerChanges: { sms_opted_out_at: '2026-09-22' } });
  await h.run(); assert.equal(h.calls.length, 0, 'consent and opt-out stop routine SMS');
}
for (const changes of [{ payment_status: 'failed' }, { payment_status: 'card_saved' }, { financial_operation_key: 'busy' }, { is_test_booking: true }, { status: 'cancelled' }, { status: 'completed' }]) {
  const h = harness({ booking: fixture(changes) }); await h.run(); assert.equal(h.calls.length, 0, JSON.stringify(changes));
}
{
  const h = harness({ beforeRead: (count, b) => { if (count === 2) b.status = 'cancelled'; } });
  await h.run(); assert.equal(h.calls.length, 0, 'fresh booking state wins over scan');
}
{
  const h = harness({ booking: fixture({ reminder_sent: true }) }); await h.run();
  assert.equal(h.calls.length, 2, 'legacy display flag does not strand missing recipient/channel notices');
  h.booking.rescheduled_at = '2026-09-22T18:00:00Z'; h.booking.time = '2:00 PM - 4:00 PM'; await h.run();
  assert.equal(h.calls.length, 4, 'new appointment has its own durable event key');
}
{
  const h = harness({ booking: { ...returnVisit, source: 'owner_manual', payment_status: 'offline_recorded' }, easerChanges: { is_owner: true } });
  await h.run(); assert.equal(h.calls.length, 2); assert.match(h.calls[0].html, /Finish the cabinet/);
  assert.ok(h.calls.every(c => c.meta.notificationKey.includes('2026-09-24')));
}
{
  let fail = true;
  const h = harness({ booking: fixture({ date: '2026-09-28', payment_authorized_at: '2026-09-17T12:00:00Z' }), outcome: () => ({ ok: !fail }) });
  assert.equal((await h.run()).expiringAuthsWarned, 0);
  fail = false; assert.equal((await h.run()).expiringAuthsWarned, 1);
  h.advance(1); assert.equal((await h.run()).expiringAuthsWarned, 0);
  assert.equal(h.calls.length, 2, 'one successful owner authorization review per local day');
  assert.doesNotMatch(h.calls[1].html, /holds last 7 days|expire within|must complete or cancel/i);
}
console.log('PASS reminder calendar cadence, quiet hours/DST/timezones, channel-specific legacy recovery, overlap/retries, consent, current-state gates, return visits, branded copy and owner warning truth.');
