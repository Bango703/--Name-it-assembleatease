import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BOOKING_WINDOW_DAYS,
  IMMEDIATE_AUTHORIZATION_DAYS,
  bookingWindow,
  needsScheduledAuthorization,
  validateBookingWindowDate,
} from '../api/booking/_booking-window.js';
import { authorizeScheduledBooking } from '../api/cron/authorize-scheduled-payments.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = file => readFile(path.join(root, file), 'utf8');
const now = new Date('2026-08-01T17:00:00.000Z');

assert.equal(BOOKING_WINDOW_DAYS, 30);
assert.equal(IMMEDIATE_AUTHORIZATION_DAYS, 6);
assert.deepEqual(bookingWindow(now), {
  firstDate: '2026-08-01',
  lastDate: '2026-08-31',
  immediateAuthorizationLastDate: '2026-08-07',
});
assert.equal(validateBookingWindowDate('2026-08-31', now).ok, true);
assert.equal(validateBookingWindowDate('2026-09-01', now).ok, false);
assert.equal(needsScheduledAuthorization('2026-08-07', now), false);
assert.equal(needsScheduledAuthorization('2026-08-08', now), true);

const booking = {
  id: '11111111-1111-4111-8111-111111111111', ref: 'AAE-FUTURE1',
  service: 'Furniture Assembly', customer_name: 'Test Customer', customer_email: 'customer@example.com',
  status: 'confirmed', payment_status: 'card_saved', date: '2026-08-20', time: '9:00 AM - 11:00 AM',
  total_price: 12500, stripe_customer_id: 'cus_test', stripe_payment_method_id: 'pm_test',
  stripe_payment_intent_id: null, service_zip: '77002', assembler_id: null,
  financial_operation_key: null, financial_operation_type: null, financial_operation_started_at: null,
};

function matches(row, filters) {
  return filters.every(filter => filter.kind === 'is'
    ? row[filter.field] == null && filter.value == null
    : row[filter.field] === filter.value);
}

function chain(filters, terminal) {
  return {
    eq(field, value) { filters.push({ kind: 'eq', field, value }); return this; },
    is(field, value) { filters.push({ kind: 'is', field, value }); return this; },
    select: terminal,
    maybeSingle: terminal,
  };
}

function fakeSupabase(initial) {
  const state = { booking: structuredClone(initial), activity: [] };
  return {
    state,
    from(table) {
      if (table === 'activity_logs') {
        return { async insert(row) { state.activity.push(row); return { error: null }; } };
      }
      assert.equal(table, 'bookings');
      return {
        update(payload) {
          const filters = [];
          return chain(filters, async () => {
            if (!matches(state.booking, filters)) return { data: [], error: null };
            Object.assign(state.booking, payload);
            return { data: [{ id: state.booking.id }], error: null };
          });
        },
        select() {
          const filters = [];
          return chain(filters, async () => ({ data: matches(state.booking, filters) ? structuredClone(state.booking) : null, error: null }));
        },
      };
    },
  };
}

const sb = fakeSupabase(booking);
const intent = {
  id: 'pi_scheduled', amount: 12500, currency: 'usd', customer: 'cus_test', payment_method: 'pm_test',
  capture_method: 'manual', livemode: false, status: 'requires_confirmation',
  metadata: { bookingId: booking.id, bookingRef: booking.ref, type: 'customer_booking', scheduledAuthorization: 'true', appointmentDate: booking.date },
};
const stripe = {
  paymentIntents: {
    async create(params, options) {
      assert.equal(params.amount, booking.total_price);
      assert.equal(params.capture_method, 'manual');
      assert.equal(params.customer, booking.stripe_customer_id);
      assert.equal(options.idempotencyKey, `scheduled-auth-create-${booking.id}-${booking.date}-${booking.total_price}`);
      return structuredClone(intent);
    },
    async confirm(id, params) {
      assert.equal(id, intent.id);
      assert.equal(params.off_session, true);
      return { ...structuredClone(intent), status: 'requires_capture', amount_capturable: 12500 };
    },
    async cancel() { throw new Error('A valid authorization must not be cancelled.'); },
  },
};

const outcome = await authorizeScheduledBooking({
  sb,
  stripe,
  booking,
  expectedLivemode: false,
  todayIso: '2026-08-15',
});
assert.deepEqual(outcome, { ok: true, authorized: true });
assert.equal(sb.state.booking.payment_status, 'authorized');
assert.equal(sb.state.booking.stripe_payment_intent_id, 'pi_scheduled');
assert.equal(sb.state.booking.dispatch_paused, false);
assert.equal(sb.state.booking.needs_manual_dispatch, true, 'Houston remains owner-assigned after authorization');
assert.equal(sb.state.booking.financial_operation_key, null);
assert.equal(sb.state.activity[0].event_type, 'payment_authorized');

const pastBooking = { ...booking, date: '2026-08-14' };
const pastSb = fakeSupabase(pastBooking);
const pastOutcome = await authorizeScheduledBooking({
  sb: pastSb,
  stripe: { paymentIntents: { async create() { throw new Error('Past appointments must never be authorized.'); } } },
  booking: pastBooking,
  expectedLivemode: false,
  todayIso: '2026-08-15',
});
assert.deepEqual(pastOutcome, { ok: false, reason: 'outside_authorization_window', actionRequired: true });
assert.equal(pastSb.state.booking.payment_status, 'card_saved');

const actionBooking = {
  ...booking,
  guest_mutation_token_hash: 'existing-secure-token-hash',
  financial_reconciliation_required_at: null,
  cancellation_reconciliation_required_at: null,
};
const actionSb = fakeSupabase(actionBooking);
const priorResendKey = process.env.RESEND_API_KEY;
delete process.env.RESEND_API_KEY;
const actionOutcome = await authorizeScheduledBooking({
  sb: actionSb,
  stripe: {
    paymentIntents: {
      async create() { return structuredClone(intent); },
      async confirm() { return { ...structuredClone(intent), status: 'requires_action' }; },
      async cancel() { throw new Error('A linked customer-action authorization must not be cancelled.'); },
    },
  },
  booking: actionBooking,
  expectedLivemode: false,
  todayIso: '2026-08-15',
});
if (priorResendKey == null) delete process.env.RESEND_API_KEY;
else process.env.RESEND_API_KEY = priorResendKey;
assert.deepEqual(actionOutcome, { ok: false, reason: 'customer_authentication_required', actionRequired: true });
assert.equal(actionSb.state.booking.payment_status, 'pending');
assert.equal(actionSb.state.booking.dispatch_status, 'payment_hold');
assert.equal(actionSb.state.booking.dispatch_paused, true);
assert.equal(actionSb.state.booking.guest_mutation_token_hash, 'existing-secure-token-hash', 'failed recovery email must restore the prior customer token');

const [bookHtml, bookingApi, setupApi, cronApi, ownerApi, marketApi, attributionScript, migration, vercel] = await Promise.all([
  source('book.html'), source('api/booking.js'), source('api/booking/setup-intent.js'),
  source('api/cron/authorize-scheduled-payments.js'), source('api/owner/live-ops.js'),
  source('api/owner/market-demand.js'), source('assets/js/mobile-nav.js'),
  source('api/migrations/056_booking_attribution.sql'), source('vercel.json'),
]);

assert.match(bookHtml, /30-day window/);
assert.match(bookHtml, /purpose: isScheduledAuthorization \? 'future_booking' : 'quote_booking'/);
assert.match(bookHtml, /booking_completed/);
assert.match(bookHtml, /attribution: BOOKING_ATTRIBUTION/);
assert.match(bookingApi, /payment_status: scheduledAuthorization \? 'card_saved'/);
assert.match(bookingApi, /dispatch_paused: scheduledAuthorization/);
assert.match(setupApi, /FUTURE_BOOKING_SETUP_NOT_ALLOWED/);
assert.match(cronApi, /payment_status: 'authorized'/);
assert.match(cronApi, /dispatch_paused: true/);
assert.match(cronApi, /date\.gte\.\$\{today\}/);
assert.match(ownerApi, /scheduled_payment_due/);
assert.match(marketApi, /getEaserReadiness/);
assert.match(marketApi, /COVERAGE NEEDED/);
assert.match(attributionScript, /aaeBookingAttribution/);
assert.match(attributionScript, /utm_source/);
assert.match(migration, /booking_attribution JSONB/);
assert.match(migration, /'authorize_scheduled_payment'/);
assert.match(migration, /bookings_financial_operation_type_check/);
assert.match(vercel, /authorize-scheduled-payments/);

console.log('Growth booking window, scheduled authorization, attribution, and coverage checks: PASS');
