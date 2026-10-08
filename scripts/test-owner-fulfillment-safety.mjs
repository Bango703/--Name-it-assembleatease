import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as truth from '../api/_source-of-truth.js';
import * as locations from '../api/_booking-location.js';
import * as appointments from '../api/booking/_appt-date.js';
import * as authorization from '../api/booking/_authorization-window.js';
import * as bookingWindow from '../api/booking/_booking-window.js';
import * as ownerEaser from '../api/_owner-easer.js';
import * as activeJobs from '../api/owner/_active-jobs.js';
import * as leakage from '../api/booking/_leakage-signal.js';
import * as arrival from '../api/booking/_arrival-follow-up.js';

// Real route handlers and canonical helpers, with only the database/auth/clock
// boundary substituted. Projection is honored: an unselected field stays absent.
const releaseSource = await readFile(new URL('../api/booking/release-assignment.js', import.meta.url), 'utf8');
const liveOpsSource = await readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8');
const fixture = changes => ({
  id: 'booking-1', ref: 'AAE-TEST', service: 'Furniture Assembly', source: 'website',
  status: 'confirmed', date: '2026-10-07', time: '9:00 AM - 11:00 AM',
  address: '123 Example St, Tyler, TX 75701', service_zip: '75701', service_city: 'Tyler',
  assembler_id: 'easer-1', assembler_name: 'Assigned Easer', assigned_at: '2026-10-06T12:00:00Z',
  assembler_accepted_at: null, assignment_token: 'old-assignment', dispatch_token: null,
  dispatch_status: 'assigned_pending_acceptance', dispatch_paused: true, needs_manual_dispatch: false,
  checked_in_at: null, return_visit_required: false, payment_status: 'authorized',
  total_price: 20000, stripe_payment_intent_id: 'pi_example', stripe_payment_method_id: 'pm_example',
  financial_operation_key: null, financial_operation_type: null, financial_operation_started_at: null,
  ...changes,
});

function harness(source, booking, options = {}) {
  const rows = { bookings: [structuredClone(booking)] };
  const calls = { writes: [], activity: [] };
  const now = Date.parse(options.now || '2026-10-07T15:00:00Z');
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.columns = '*'; }
    select(columns) { this.columns = columns || '*'; return this; }
    update(patch) { this.patch = patch; return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
    is(key, value) { this.filters.push(row => (row[key] ?? null) === value); return this; }
    not(key, op, value) {
      this.filters.push(row => op === 'is' ? (row[key] ?? null) !== value : !JSON.parse(value.replace(/^\(/, '[').replace(/\)$/, ']')).includes(row[key]));
      return this;
    }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
    gt(key, value) { this.filters.push(row => row[key] > value); return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (this.patch) options.beforeUpdate?.(rows.bookings[0]);
        const selected = (rows[this.table] || []).filter(row => this.filters.every(filter => filter(row)));
        if (this.patch) {
          selected.forEach(row => Object.assign(row, structuredClone(this.patch)));
          if (selected.length) calls.writes.push(structuredClone(this.patch));
        }
        const projected = selected.map(row => this.columns === '*' ? structuredClone(row) : Object.fromEntries(this.columns.split(',').map(column => column.trim()).map(column => [column, row[column]])));
        return { data: this.one ? projected[0] || null : projected, error: null };
      }).then(resolve, reject);
    }
  }
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({
    console, Date: Clock, process: { env: { VERCEL_ENV: 'production' } },
    ...truth, ...locations, ...appointments, ...authorization, ...bookingWindow, ...ownerEaser, ...activeJobs, ...leakage, ...arrival,
    getSupabase: () => ({ from: table => new Query(table) }),
    verifyOwner: () => options.authorized !== false,
    logActivity: async (_sb, event) => { calls.activity.push(event); },
    notificationOwnerAction: () => null,
    hasEffectiveEaserMembership: () => false,
    getEaserReadiness: async () => { throw new Error('No Easer profiles expected in fixture'); },
  });
  const executable = source.replace(/^import\s+[\s\S]*?;\r?\n/gm, '').replace('export default async function handler', 'async function handler').replace(/export (async )?function /g, '$1function ');
  vm.runInContext(executable + '\nglobalThis.handler = handler;', context);
  const run = async () => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await context.handler({ method: options.method || 'POST', body: { bookingId: booking.id }, headers: {} }, response);
    return response;
  };
  return { run, calls, booking: rows.bookings[0] };
}

let passed = 0;
let failed = 0;
async function test(name, check) {
  try { await check(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}

for (const zip of ['75701', '75201', '77001', null]) {
  await test(`release preserves manual coverage gate for ${zip || 'unknown ZIP'}`, async () => {
    const h = harness(releaseSource, fixture({ service_zip: zip, address: zip ? `123 Example St, TX ${zip}` : '78701 Example St' }));
    const result = await h.run();
    assert.equal(result.statusCode, 200);
    assert.equal(h.booking.needs_manual_dispatch, true);
    assert.equal(h.booking.dispatch_paused, false);
    assert.equal(h.booking.assembler_id, null);
  });
}
for (const zip of ['78701', '78201']) {
  await test(`release allows canonical automatic market ${zip} and invalidates tokens`, async () => {
    const h = harness(releaseSource, fixture({ service_zip: zip, dispatch_token: 'old-dispatch' }));
    assert.equal((await h.run()).statusCode, 200);
    assert.equal(h.booking.needs_manual_dispatch, false);
    assert.equal(h.booking.assignment_token, null);
    assert.equal(h.booking.dispatch_token, null);
    assert.equal(h.booking.payment_status, 'authorized');
    assert.equal(h.booking.total_price, 20000);
    assert.equal(h.calls.activity.length, 1);
  });
}
await test('release reads trailing ZIP from legacy address', async () => {
  const h = harness(releaseSource, fixture({ service_zip: null, address: '123 Example St, Austin, TX 78701' }));
  assert.equal((await h.run()).statusCode, 200);
  assert.equal(h.booking.needs_manual_dispatch, false);
});
for (const change of [
  { assembler_accepted_at: '2026-10-07T14:59:59Z' },
  { dispatch_status: 'accepted' },
  { dispatch_paused: false },
  { assembler_id: 'easer-2' },
  { assigned_at: '2026-10-07T14:59:59Z' },
  { assignment_token: 'new-assignment' },
  { dispatch_token: 'new-dispatch' },
  { financial_operation_key: 'capture-lock' },
  { financial_operation_type: 'cancel' },
  { financial_operation_started_at: '2026-10-07T14:59:59Z' },
  { date: '2026-10-08' },
  { time: '12:00 PM' },
  { service_zip: '78701' },
  { address: '123 Example St, Austin, TX 78701' },
  { status: 'cancelled' },
]) {
  await test(`release rejects concurrent ${Object.keys(change)[0]} change`, async () => {
    const h = harness(releaseSource, fixture(), { beforeUpdate: row => Object.assign(row, change) });
    assert.equal((await h.run()).statusCode, 409);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.calls.activity.length, 0);
  });
}
for (const change of [{ assembler_accepted_at: '2026-10-07T14:59:59Z' }, { dispatch_status: 'accepted' }, { financial_operation_key: 'lock' }]) {
  await test(`release refuses existing ${Object.keys(change)[0]}`, async () => {
    const h = harness(releaseSource, fixture(change));
    assert.equal((await h.run()).statusCode, 409);
    assert.equal(h.calls.writes.length, 0);
  });
}
await test('release requires owner authentication', async () => {
  const h = harness(releaseSource, fixture(), { authorized: false });
  assert.equal((await h.run()).statusCode, 401);
  assert.equal(h.calls.writes.length, 0);
});
await test('saved-card assignment appears in acceptance list, count and follow-up alert', async () => {
  const h = harness(liveOpsSource, fixture({ payment_status: 'card_saved', stripe_payment_intent_id: null, date: '2026-10-16' }));
  const { body } = await h.run();
  assert.equal(body.awaitingAcceptance.length, 1);
  assert.equal(body.summary.awaitingAcceptance, 1);
  assert.ok(body.alerts.some(alert => alert.type === 'no_acceptance'));
  assert.equal(body.summary.totalActive, body.activeJobs.length);
  assert.equal(body.activeJobs[0]._stage, 'awaiting_accept');
  assert.equal(h.calls.writes.length, 0);
});
await test('accepted saved-card job stays scheduled without acceptance alert', async () => {
  const h = harness(liveOpsSource, fixture({ payment_status: 'card_saved', stripe_payment_intent_id: null, date: '2026-10-16', assembler_accepted_at: '2026-10-06T13:00:00Z' }));
  const { body } = await h.run();
  assert.equal(body.awaitingAcceptance.length, 0);
  assert.equal(body.activeJobs[0]._stage, 'scheduled');
  assert.equal(body.alerts.some(alert => ['no_acceptance', 'arrival_follow_up'].includes(alert.type)), false);
});
await test('accepted saved-card authorization alert does not claim staffing is paused', async () => {
  const date = bookingWindow.addIsoDays('2026-10-07', bookingWindow.SCHEDULED_AUTHORIZATION_LEAD_DAYS);
  const h = harness(liveOpsSource, fixture({ payment_status: 'card_saved', stripe_payment_intent_id: null, date, assembler_accepted_at: '2026-10-06T13:00:00Z' }));
  const { body } = await h.run();
  const alert = body.alerts.find(row => row.type === 'scheduled_payment_due');
  assert.ok(alert);
  assert.doesNotMatch(alert.message, /dispatch remains paused/i);
  assert.equal(body.activeJobs[0]._stage, 'scheduled');
});
await test('saved-card authorization alert waits for the canonical lead window', async () => {
  const date = bookingWindow.addIsoDays('2026-10-07', bookingWindow.SCHEDULED_AUTHORIZATION_LEAD_DAYS + 1);
  const h = harness(liveOpsSource, fixture({ payment_status: 'card_saved', stripe_payment_intent_id: null, date, assembler_accepted_at: '2026-10-06T13:00:00Z' }));
  const { body } = await h.run();
  assert.equal(body.alerts.some(row => row.type === 'scheduled_payment_due'), false);
});
await test('manual-coverage alert does not invent exhausted dispatch attempts', async () => {
  const h = harness(liveOpsSource, fixture({ assembler_id: null, needs_manual_dispatch: true }));
  const { body } = await h.run();
  const alert = body.alerts.find(row => row.type === 'needs_manual_dispatch');
  assert.ok(alert);
  assert.doesNotMatch(alert.message, /max attempts reached/i);
  assert.equal(alert.action, 'review_timeline');
  assert.equal(body.alerts.find(row => row.type === 'today_unassigned')?.action, 'review_timeline');
});
for (const change of [{ stripe_payment_method_id: null }, { financial_operation_key: 'lock' }, { financial_reconciliation_required_at: '2026-10-06T13:00:00Z' }]) {
  await test(`saved-card acceptance reporting respects ${Object.keys(change)[0]}`, async () => {
    const h = harness(liveOpsSource, fixture({ payment_status: 'card_saved', stripe_payment_intent_id: null, date: '2026-10-16', ...change }));
    assert.equal((await h.run()).body.awaitingAcceptance.length, 0);
  });
}
await test('accepted booking with no arrival becomes owner follow-up at the existing 60-minute threshold', async () => {
  const h = harness(liveOpsSource, fixture({ assembler_accepted_at: '2026-10-06T13:00:00Z' }));
  const { body } = await h.run();
  const alert = body.alerts.find(row => row.type === 'arrival_follow_up');
  assert.ok(alert);
  assert.equal(alert.action, 'review_timeline');
  assert.equal(alert.severity, 'high');
  assert.match(alert.message, /arrival has not been recorded/i);
  assert.equal(h.calls.writes.length, 0, 'review is read-only, never an automatic reassignment or charge');
});
for (const change of [{ status: 'arrived' }, { status: 'in_progress' }, { status: 'completed' }, { status: 'cancelled' }, { checked_in_at: '2026-10-07T14:59:00Z' }, { return_visit_required: true }, { assembler_accepted_at: null }, { assembler_id: null }, { time: 'TBD' }, { date: '2026-10-03' }, { date: '2026-10-08' }]) {
  await test(`arrival follow-up excludes ${JSON.stringify(change)}`, async () => {
    const h = harness(liveOpsSource, fixture({ assembler_accepted_at: '2026-10-06T13:00:00Z', ...change }));
    assert.equal((await h.run()).body.alerts.some(row => row.type === 'arrival_follow_up'), false);
  });
}
await test('arrival follow-up respects the appointment timezone and grace boundary', async () => {
  const booking = fixture({ assembler_accepted_at: '2026-10-06T13:00:00Z', service_zip: '79901', service_city: 'El Paso', address: '123 Example St' });
  for (const [now, expected] of [['2026-10-07T15:59:59Z', false], ['2026-10-07T16:00:00Z', true]]) {
    const h = harness(liveOpsSource, booking, { now });
    assert.equal((await h.run()).body.alerts.some(row => row.type === 'arrival_follow_up'), expected);
  }
});
console.log(`Owner fulfillment safety: ${passed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
