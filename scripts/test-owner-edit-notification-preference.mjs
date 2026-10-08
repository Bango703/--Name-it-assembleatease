import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appointmentTimestampMs, formatAppointmentDate } from '../api/booking/_appt-date.js';
import { validateBookingWindowDate } from '../api/booking/_booking-window.js';

// Execute the production handler with isolated persistence and notification
// boundaries. No environment file, network, live write, or delivery is used.
const source = (await readFile(new URL('../api/owner/edit-booking.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default async function', 'async function');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const initialBooking = overrides => ({
  id: 'booking-1', ref: 'AAE-TEST', source: 'website', status: 'confirmed',
  customer_name: 'Customer Test', customer_email: 'customer@example.test',
  date: '2026-10-01', time: '10:00 AM', address: '100 Test Street, Austin, TX 78701', service: 'Furniture assembly',
  payment_status: 'pending', total_price: 10000, reminder_sent: true,
  assembler_id: 'easer-1', assembler_accepted_at: '2026-09-28T10:00:00Z',
  assigned_at: '2026-09-27T10:00:00Z', assignment_token: 'old-token',
  dispatch_status: 'accepted', dispatch_attempt: 2, dispatch_token: 'old-dispatch-token',
  dispatch_paused: false, needs_manual_dispatch: false, ...overrides,
});

async function fixture(overrides = {}, options = {}) {
  const rows = { bookings: [initialBooking(overrides)], profiles: [{ id: 'easer-1', email: 'easer@example.test', full_name: 'Easer Test' }],
    dispatch_offers: [{ booking_id: 'booking-1', offer_status: 'sent' }] };
  const messages = [], queued = [], activities = [], writes = [];
  const sb = { from(table) {
    const predicates = [];
    let patch, single = false;
    const query = {
      select() { return query; },
      eq(column, value) { predicates.push(row => row[column] === value); return query; },
      is(column, value) { predicates.push(row => row[column] == value); return query; },
      update(value) { patch = value; return query; },
      single() { single = true; return query; },
      maybeSingle() { single = true; return query; },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (table === 'bookings' && patch && options.saveFails) return { data: null, error: { message: 'Save failed' } };
          if (table === 'bookings' && patch && options.saveConflict) return { data: [], error: null };
          if (table === 'dispatch_offers' && patch && options.cleanupFails) return { data: null, error: { message: 'Cleanup failed' } };
          const matches = rows[table].filter(row => predicates.every(test => test(row)));
          if (patch) { writes.push({ table, patch: structuredClone(patch) }); matches.forEach(row => Object.assign(row, patch)); }
          return { data: structuredClone(single ? matches[0] || null : matches), error: null };
        }).then(resolve, reject);
      },
    };
    return query;
  } };
  const dependencies = {
    randomUUID: () => 'new-assignment-token', getSupabase: () => sb, verifyOwner: () => options.authorized !== false,
    sendEmail: async message => {
      messages.push(message);
      const outcome = options[`${message.meta.recipientType}Outcome`] || { ok: true };
      if (outcome instanceof Error) throw outcome;
      if (outcome.deferred || outcome.retryScheduled) queued.push(message);
      return outcome;
    },
    buildStatusEmail: input => `<h1>${input.headline}</h1>${input.bodyHtml}`,
    ownerEmail: () => 'owner@example.test', esc: value => String(value ?? ''), formatAddress: value => value,
    logActivity: async (_sb, input) => activities.push(input), appointmentTimestampMs, formatAppointmentDate, validateBookingWindowDate,
    console: { log() {}, error() {} },
  };
  const handler = await new AsyncFunction(...Object.keys(dependencies), `${source}\nreturn handler;`)(...Object.values(dependencies));
  return { rows, messages, queued, activities, writes, async run(body, method = 'POST') {
    const response = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ method, body: { bookingId: 'booking-1', ...body } }, response);
    return response;
  } };
}
const recipients = f => f.messages.map(message => message.meta.recipientType);
const unassigned = { assembler_id: null, assembler_accepted_at: null, assigned_at: null, assignment_token: null, dispatch_status: null };

// An explicit false blocks every customer notification entry point, including
// the shared sender's queue, while the Easer must still accept a new schedule.
for (const patch of [{ date: '2026-10-02' }, { time: '1:00 PM' }, { date: '2026-10-02', time: '1:00 PM' }]) {
  const f = await fixture({}, { customerOutcome: { ok: false, deferred: true }, easerOutcome: { ok: false, deferred: true } });
  const result = await f.run({ ...patch, notifyCustomer: false });
  assert.equal(result.code, 200); assert.equal(result.body.ok, true);
  assert.equal(result.body.easerReconfirmationRequired, true);
  assert.deepEqual(recipients(f), ['easer']);
  assert.deepEqual(f.queued.map(message => message.meta.recipientType), ['easer']);
  assert.ok(result.body.notificationFailures.every(failure => failure.recipient !== 'customer'));
  assert.equal(f.rows.bookings[0].assembler_accepted_at, null);
  assert.equal(f.rows.bookings[0].assignment_token, 'new-assignment-token');
  assert.equal(f.rows.bookings[0].dispatch_status, 'reconfirmation_required');
  assert.equal(f.rows.bookings[0].dispatch_paused, true);
  assert.equal(f.rows.bookings[0].dispatch_attempt, 3);
  assert.equal(f.rows.bookings[0].reminder_sent, false);
  assert.equal(f.rows.dispatch_offers[0].offer_status, 'cancelled');
  assert.match(f.messages[0].html, /token=new-assignment-token/);
}

for (const preference of [false, true, undefined]) {
  for (const patch of [{ date: '2026-10-02' }, { address: '200 Test Street, Austin, TX 78701' }, { service: 'TV mounting' }]) {
    const f = await fixture(unassigned);
    const body = { ...patch, ...(preference === undefined ? {} : { notifyCustomer: preference }) };
    const result = await f.run(body);
    assert.equal(result.code, 200);
    const expected = preference === true || (preference === undefined && Boolean(patch.date));
    assert.deepEqual(recipients(f), expected ? ['customer'] : [], `preference ${preference}, ${Object.keys(patch)[0]}`);
    assert.equal(result.body.easerReconfirmationRequired, false);
    if (expected) assert.equal(f.messages[0].meta.notificationType, 'owner_booking_update_customer');
  }

  const assigned = await fixture();
  const scheduled = await assigned.run({ date: '2026-10-02', ...(preference === undefined ? {} : { notifyCustomer: preference }) });
  assert.equal(scheduled.code, 200);
  assert.deepEqual(recipients(assigned), preference === false ? ['easer'] : ['customer', 'easer']);

  const missingEmail = await fixture({ customer_email: null });
  const missingResult = await missingEmail.run({ date: '2026-10-02', ...(preference === undefined ? {} : { notifyCustomer: preference }) });
  assert.deepEqual(recipients(missingEmail), ['easer']);
  assert.deepEqual(missingResult.body.notificationFailures, preference === false ? [] : [{ recipient: 'customer', error: 'Customer email is missing' }]);

  const noop = await fixture();
  const noopResult = await noop.run({ date: '2026-10-01', time: '10:00 AM', ...(preference === undefined ? {} : { notifyCustomer: preference }) });
  assert.equal(noopResult.code, 200); assert.equal(noopResult.body.easerReconfirmationRequired, false);
  assert.deepEqual(noop.messages, []); assert.deepEqual(noopResult.body.notificationFailures, []);
  assert.equal(noop.rows.bookings[0].assignment_token, 'old-token');
  assert.equal(noop.rows.dispatch_offers[0].offer_status, 'sent');
}

for (const preference of [false, true]) {
  for (const options of [{ saveFails: true }, { saveConflict: true }]) {
    const f = await fixture({}, options);
    const result = await f.run({ date: '2026-10-02', notifyCustomer: preference });
    assert.equal(result.code, 409); assert.deepEqual(f.messages, []); assert.deepEqual(f.queued, []);
    assert.deepEqual(f.activities, []); assert.deepEqual(f.writes, []);
    assert.equal(f.rows.bookings[0].date, '2026-10-01');
  }
}

for (const customerOutcome of [{ ok: false, error: 'Rejected' }, new Error('Provider unavailable'), { ok: false, deferred: true }]) {
  const f = await fixture({}, { customerOutcome });
  const result = await f.run({ date: '2026-10-02', notifyCustomer: true });
  assert.equal(result.code, 200); assert.equal(result.body.ok, true);
  assert.equal(f.rows.bookings[0].date, '2026-10-02');
  assert.deepEqual(recipients(f), ['customer', 'easer']);
  assert.deepEqual(result.body.notificationFailures.map(failure => failure.recipient), ['customer']);
  assert.equal(f.activities.at(-1).eventType, 'owner_booking_update_notification_failed');
}

{
  const f = await fixture({}, { customerOutcome: new Error('Must not be reached'), easerOutcome: new Error('Easer provider unavailable'), cleanupFails: true });
  const result = await f.run({ date: '2026-10-02', notifyCustomer: false });
  assert.equal(result.code, 200); assert.equal(result.body.ok, true);
  assert.deepEqual(recipients(f), ['easer']);
  assert.deepEqual(result.body.notificationFailures.map(failure => failure.recipient), ['easer', 'dispatch']);
  assert.equal(f.rows.bookings[0].date, '2026-10-02');
}
{
  const f = await fixture({ source: 'owner_manual', status: 'completed' });
  const result = await f.run({ date: '2026-10-02', notifyCustomer: true });
  assert.equal(result.code, 200); assert.equal(result.body.recordOnlyOwnerManual, true);
  assert.deepEqual(f.messages, []); assert.equal(result.body.easerReconfirmationRequired, false);
}
{
  const f = await fixture();
  assert.equal((await f.run({ notifyCustomer: true })).code, 400);
  assert.equal((await f.run({ date: '2026-10-02' }, 'GET')).code, 405);
  assert.deepEqual(f.messages, []); assert.deepEqual(f.writes, []);
  const unauthorized = await fixture({}, { authorized: false });
  assert.equal((await unauthorized.run({ date: '2026-10-02', notifyCustomer: true })).code, 401);
  assert.deepEqual(unauthorized.messages, []); assert.deepEqual(unauthorized.writes, []);
}

console.log('PASS: owner edit respects customer notification preference without bypassing Easer reconfirmation or save safety');
