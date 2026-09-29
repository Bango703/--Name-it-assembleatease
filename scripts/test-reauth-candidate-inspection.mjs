import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as windowPolicy from '../api/booking/_authorization-window.js';
import * as email from '../api/_email.js';
import { formatAppointmentDate } from '../api/booking/_appt-date.js';

const NOW = '2026-09-28T21:00:00Z';
const row = changes => ({
  id: 'booking-1', ref: 'AAE-REVIEW', status: 'confirmed', payment_status: 'authorized',
  service: 'Furniture assembly', date: '2026-09-30', time: '8:00 AM - 10:00 AM',
  total_price: 38321, stripe_customer_id: 'cus_fixture', stripe_payment_intent_id: 'pi_fixture',
  payment_authorized_at: '2026-09-23T20:57:55Z', authorization_capture_before: null,
  financial_operation_key: null, financial_operation_type: null, financial_operation_started_at: null,
  financial_reconciliation_required_at: null, cancellation_reconciliation_required_at: null,
  return_visit_required: false, return_visit_date: null, return_visit_time: null, ...changes,
});
const intent = (booking, changes = {}) => ({
  id: booking.stripe_payment_intent_id, status: 'requires_capture', capture_method: 'manual',
  amount: booking.total_price, amount_capturable: booking.total_price, currency: 'usd',
  customer: booking.stripe_customer_id, livemode: false, payment_method: 'pm_fixture',
  metadata: { bookingId: booking.id, bookingRef: booking.ref, type: 'customer_booking' },
  latest_charge: { payment_method_details: { card: { capture_before: Date.parse('2026-09-30T20:57:53Z') / 1000 } } },
  ...changes,
});
const deadline = value => ({ latest_charge: { payment_method_details: { card: { capture_before: Date.parse(value) / 1000 } } } });
const source = (await readFile(new URL('../api/cron/reauth-payments.js', import.meta.url), 'utf8'))
  .replace(/^\uFEFF/, '')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default async function handler', 'async function handler')
  // Exercise the actual handler, queries, live inspection, deadline CAS, and
  // alerts. Existing safety tests exercise the financial processor itself.
  .replace('export async function processBookingReauthorization', 'async function unusedFinancialProcessor')
  .replace(/export (async )?function /g, '$1function ');

function harness({ bookings = [row()], intents, retrieveError = false, updateError = false,
  unknownPageError = false, beforeUpdate, beforeSingleRead, processResult = { ok: true, changed: false },
  emailResult, now = NOW } = {}) {
  const state = structuredClone(bookings);
  const byIntent = new Map((intents || bookings.map(b => intent(b))).map(p => [p.id, p]));
  const events = [], processes = [], sends = [], attempts = [], queries = [];
  const delivered = new Set();
  let clock = Date.parse(now);
  class Query {
    constructor() { this.filters = []; this.offset = 0; this.end = Infinity; }
    select() { return this; }
    eq(field, value) { this.filters.push(b => b[field] === value); return this; }
    is(field, value) { this.filters.push(b => (b[field] ?? null) === value); if (field === 'authorization_capture_before') this.unknown = true; return this; }
    or(expression) {
      this.expression = expression;
      if (expression.includes('authorization_capture_before.is.null')) this.unknown = true;
      const predicates = expression.split(',').map(clause => {
        const match = clause.match(/^([^\.]+)\.(eq|lte|is)\.(.*)$/); assert.ok(match, clause);
        const [, field, op, value] = match;
        return b => op === 'is' ? b[field] == null : op === 'eq' ? b[field] === value : b[field] != null && b[field] <= value;
      });
      this.filters.push(b => predicates.some(predicate => predicate(b))); return this;
    }
    order(field) { this.sort = field; return this; }
    limit(count) { this.end = count - 1; return this; }
    range(start, end) { this.offset = start; this.end = end; return this; }
    maybeSingle() { this.single = true; return this; }
    update(patch) { this.patch = patch; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => {
      queries.push({ expression: this.expression, unknown: this.unknown, offset: this.offset, patch: this.patch });
      if (this.patch) beforeUpdate?.(state);
      if (this.single) beforeSingleRead?.(state);
      if (this.patch && updateError) return { data: null, error: { message: 'deadline write unavailable' } };
      if (!this.patch && this.unknown && unknownPageError) return { data: null, error: { message: 'unknown deadline query failed' } };
      let rows = state.filter(b => this.filters.every(predicate => predicate(b)));
      if (this.sort) rows.sort((a, b) => String(a[this.sort]).localeCompare(String(b[this.sort])));
      rows = rows.slice(this.offset, this.end + 1);
      if (this.patch) {
        assert.deepEqual(Object.keys(this.patch), ['authorization_capture_before'], 'inspection may project only the verified deadline');
        rows.forEach(b => Object.assign(b, this.patch)); events.push('deadline-write');
      }
      const copies = structuredClone(rows);
      return { data: this.single ? copies[0] || null : copies, error: null };
    }).then(resolve, reject); }
  }
  const sb = { from(table) { assert.equal(table, 'bookings'); return new Query(); },
    rpc() { assert.fail('preflight must never reserve or call a financial RPC'); } };
  const stripe = { paymentIntents: {
    async retrieve(id, options) {
      events.push('retrieve:' + id); assert.deepEqual(JSON.parse(JSON.stringify(options)), { expand: ['latest_charge'] });
      if (retrieveError) throw new Error('Stripe unavailable');
      assert.ok(byIntent.has(id)); return structuredClone(byIntent.get(id));
    },
    create() { assert.fail('preflight must not create any payment'); },
    cancel() { assert.fail('preflight must not cancel any payment'); },
    capture() { assert.fail('preflight must not collect any payment'); },
  } };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = vm.createContext({ Date: Clock, console: { ...console, error() {} },
    process: { env: { CRON_SECRET: 'fixture-secret', STRIPE_SECRET_KEY: 'sk_test_fixture' } },
    ...windowPolicy, ...email, formatAppointmentDate, getSupabase: () => sb,
    Stripe: class { constructor() { return stripe; } }, logCron: async () => {},
    ownerEmail: () => 'owner@example.test',
    async processBookingReauthorization(args) { processes.push(structuredClone(args.booking)); events.push('process:' + args.booking.id); return processResult; },
    async sendEmail(args) {
      attempts.push(args);
      const key = args.meta.notificationKey || 'unkeyed:' + attempts.length;
      if (delivered.has(key)) return { ok: true, suppressed: true };
      const result = emailResult?.(args, attempts.length) || { ok: true };
      if (result.ok) { delivered.add(key); sends.push(args); }
      return result;
    },
  });
  vm.runInContext(source + '\nglobalThis.runHandler = handler;', context);
  return { state, byIntent, events, processes, sends, attempts, queries,
    advance: hours => { clock += hours * 3600000; },
    async run(authorization = 'Bearer fixture-secret') {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await context.runHandler({ headers: { authorization } }, res); return res;
    },
  };
}

// The screenshot booking: outside the five-day date filter, no DB deadline,
// live hold expires before the canonical completion. Select and inspect it.
{
  const h = harness(); const result = await h.run();
  assert.equal(result.code, 200); assert.equal(h.processes.length, 1);
  assert.equal(h.processes[0].authorization_capture_before, '2026-09-30T20:57:53.000Z');
  assert.equal(h.state[0].authorization_capture_before, '2026-09-30T20:57:53.000Z');
  assert.deepEqual(h.events, ['retrieve:pi_fixture', 'deadline-write', 'process:booking-1']);
  assert.equal(h.sends.length, 0, 'inspection alone sends no customer or owner email');
}
// A healthy unknown hold must remain healthy after its deadline is persisted,
// including repeated scans on the legacy exact-five-day appointment date.
{
  const b = row({ date: '2026-10-03' });
  const h = harness({ bookings: [b], intents: [intent(b, deadline('2026-10-05T20:00:00Z'))] });
  await h.run(); h.advance(1); await h.run();
  assert.equal(h.processes.length, 0); assert.equal(h.sends.length, 0);
  assert.equal(h.state[0].authorization_capture_before, '2026-10-05T20:00:00.000Z');
  assert.equal(h.events.filter(event => event.startsWith('retrieve:')).length, 1, 'saved verified deadline is reused');
}
for (const changes of [
  { status: 'succeeded', amount_capturable: 0 },
  { status: 'canceled', amount_capturable: 0 },
  { latest_charge: null },
  { customer: 'cus_other' },
  { amount: 1 }, { livemode: true },
  { metadata: { bookingId: 'another', bookingRef: 'another', type: 'customer_booking' } },
]) {
  const b = row(); const h = harness({ bookings: [b], intents: [intent(b, changes)] });
  await h.run(); h.advance(24); await h.run();
  assert.equal(h.processes.length, 0); assert.equal(h.events.includes('deadline-write'), false);
  assert.equal(h.sends.length, 1, 'same unresolved hold gets one durable owner notice, not a daily duplicate');
  const message = h.sends[0];
  assert.equal(message.meta.recipientType, 'owner');
  assert.ok(message.meta.notificationKey.includes(b.stripe_payment_intent_id));
  for (const field of ['stripe_payment_intent_id', 'authorization_capture_before', 'total_price', 'stripe_customer_id',
    'date', 'time', 'return_visit_required', 'return_visit_date', 'return_visit_time']) {
    assert.equal(message.meta.paymentReviewSnapshot[field], b[field] ?? null, 'queued retry retains the exact inspected payment snapshot');
  }
  assert.doesNotMatch(message.html, /PaymentIntent|reconciliation marker|is locked|aging card|Retry Authorization/);
  assert.match(message.html, /owner dashboard/);
  if (changes.status === 'succeeded') assert.match(message.html, /Do not charge the customer again/);
  if (changes.customer) assert.doesNotMatch(message.html, /payment was collected|hold was canceled/);
}
{
  const h = harness({ retrieveError: true, emailResult: (_args, number) => ({ ok: number !== 1 }) });
  const first = await h.run(); assert.ok(first.body.errors.some(error => error.reason === 'payment_review_notification_failed'));
  await h.run(); await h.run();
  assert.equal(h.sends.length, 1, 'a failed owner notice retries and a successful one suppresses');
  assert.equal(h.processes.length, 0); assert.equal(h.events.includes('deadline-write'), false);
}
// A healthy/null deadline must never short-circuit an existing exact recovery.
for (const captureBefore of [null, '2026-10-05T20:00:00Z']) {
  const b = row({ authorization_capture_before: captureBefore, financial_operation_key: 'reauth:booking-1',
    financial_operation_type: 'reauth_payment', financial_operation_started_at: NOW });
  const h = harness({ bookings: [b] }); await h.run();
  assert.equal(h.processes.length, 1); assert.equal(h.events.some(event => event.startsWith('retrieve:')), false);
}
{
  const h = harness({ bookings: [row({ payment_method_type: 'klarna' })] }); await h.run();
  assert.equal(h.events.some(event => event.startsWith('retrieve:')), false, 'Klarna does not use a card capture deadline');
  assert.equal(h.sends.length, 0);
}
{
  const h = harness({ bookings: [row({ is_test_booking: true })] }); await h.run();
  assert.equal(h.events.length, 0, 'test bookings cause no inspection, renewal, projection or owner email');
}
for (const race of [
  { payment_status: 'captured' }, { stripe_payment_intent_id: 'pi_replacement' },
  { total_price: 40000 }, { date: '2026-10-01' }, { time: '2:00 PM - 4:00 PM' },
  { authorization_capture_before: '2026-10-06T20:00:00Z' },
  { financial_operation_key: 'capture:booking-1' }, { financial_reconciliation_required_at: NOW },
]) {
  const h = harness({ beforeUpdate: state => Object.assign(state[0], race) }); await h.run();
  assert.equal(h.processes.length, 0, 'changed booking prevents stale renewal');
  assert.equal(h.sends.length, 0, 'changed booking prevents stale warnings');
  if (!race.authorization_capture_before) assert.equal(h.state[0].authorization_capture_before, null, 'failed CAS cannot claim a saved deadline');
}
{
  const h = harness({ updateError: true }); const result = await h.run();
  assert.equal(h.state[0].authorization_capture_before, null); assert.equal(h.processes.length, 0);
  assert.ok(result.body.errors.some(error => error.reason === 'payment_deadline_save_failed'));
  assert.match(h.sends[0].html, /could not be saved/);
}
for (const race of [{ payment_status: 'captured' }, { stripe_payment_intent_id: 'pi_new' }, { status: 'cancelled' }, { is_test_booking: true }]) {
  const h = harness({ retrieveError: true, beforeSingleRead: state => Object.assign(state[0], race) }); await h.run();
  assert.equal(h.sends.length, 0, 'reload immediately before owner notice prevents stale warning');
}
{
  const b = row({ authorization_capture_before: '2026-09-30T20:57:53Z' });
  const h = harness({ bookings: [b], processResult: { ok: false, paymentReviewRequired: true, paymentReviewReason: 'payment_hold_canceled', reason: 'source_payment_intent_invalid:status,amount_capturable' } });
  await h.run(); await h.run();
  assert.equal(h.sends.length, 1, 'source invalidated under the financial lock receives a durable review notice');
  assert.doesNotMatch(h.sends[0].html, /is locked/);
}
// More legacy unknowns than the old single query's cap cannot starve known
// due work, disappear after page 1, or cause the calendar matches to run twice.
{
  const urgent = row({ id: 'urgent', authorization_capture_before: '2026-09-30T20:57:53Z' });
  const unknown = Array.from({ length: 105 }, (_, i) => row({ id: `legacy-${String(i).padStart(3, '0')}`,
    ref: `AAE-LEGACY-${i}`, stripe_payment_intent_id: `pi_legacy_${i}`, date: '2026-10-03' }));
  const h = harness({ bookings: [...unknown, urgent], intents: [intent(urgent), ...unknown.map(b => intent(b, deadline('2026-10-05T20:00:00Z')))] });
  await h.run();
  assert.equal(h.processes.length, 1); assert.equal(h.processes[0].id, 'urgent');
  assert.equal(h.events[0], 'process:urgent');
  assert.equal(h.events.filter(event => event === 'deadline-write').length, 105);
  assert.ok(h.queries.some(query => query.unknown && query.offset === 100));
}
{
  const h = harness({ unknownPageError: true }); const result = await h.run();
  assert.equal(result.code, 500); assert.equal(h.processes.length, 0); assert.equal(h.sends.length, 0);
}
{
  const h = harness(); assert.equal((await h.run('Bearer wrong')).code, 401); assert.equal(h.queries.length, 0);
}
console.log('PASS real renewal handler: null-deadline inspection, canonical decision, deadline-only CAS, paging, preserved recovery, owner action/dedup, no blind financial operations.');
