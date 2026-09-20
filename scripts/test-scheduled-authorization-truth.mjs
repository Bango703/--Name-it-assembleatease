#!/usr/bin/env node
// The scheduled card hold, exercised for real.
//
// 2026-09-19, booking AAE-DVSNHXE4OO: the nightly job created the hold and the
// confirm call never reached Stripe. The PaymentIntent sat at
// `requires_confirmation` with `last_payment_error: null`, and Stripe's event
// log held nothing but `payment_intent.created` — the bank was never asked
// anything. The job nevertheless emailed the customer "your bank needs one more
// confirmation" about a card she had already given, told the assigned Easer
// "do not travel", and moved the booking to a status its own query cannot see,
// so no later run could ever fix it. A staffed job five days out was stranded
// by one dropped request.
//
// These tests run the shipped functions against a scripted Stripe and a fake
// database, and assert who hears about what.

import assert from 'node:assert/strict';
import {
  authorizeScheduledBooking,
  recoverUnconfirmedHolds,
} from '../api/cron/authorize-scheduled-payments.js';
import { classifyAuthorizationOutcome } from '../api/booking/_authorization-outcome.js';

const BOOKING_ID = '1a873721-f1a2-44bf-b092-5d1b3398c32b';
const AMOUNT = 42651;

function baseBooking(overrides = {}) {
  return {
    id: BOOKING_ID,
    ref: 'AAE-TESTHOLD01',
    status: 'confirmed',
    payment_status: 'card_saved',
    date: '2026-09-24',
    time: '8:00 AM – 10:00 AM',
    service: 'Outdoor & Playsets',
    customer_name: 'Sample Customer',
    customer_email: 'customer@example.com',
    total_price: AMOUNT,
    stripe_customer_id: 'cus_test',
    stripe_payment_method_id: 'pm_test',
    stripe_payment_intent_id: null,
    assembler_id: 'f1a2c0e9-b2e0-4f19-85cb-0c795d95a6ff',
    guest_mutation_token_hash: null,
    service_zip: '77389',
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
    financial_reconciliation_required_at: null,
    cancellation_reconciliation_required_at: null,
    dispatch_status: null,
    dispatch_paused: true,
    ...overrides,
  };
}

// ── A database that applies the same filters the real one would ─────────────
function fakeDb(booking) {
  const row = { ...booking };
  const log = { updates: [], activity: [], selectFilters: [] };

  function query(table, op, payload) {
    const filters = [];
    const api = {
      eq(column, value) { filters.push([column, value]); return api; },
      is(column, value) { filters.push([column, value]); return api; },
      not(column) { filters.push([column, '__not_null__']); return api; },
      gte() { return api; },
      lte() { return api; },
      or() { return api; },
      limit() { return api; },
      select() { return api; },
      maybeSingle() { return Promise.resolve({ data: { ...row }, error: null }); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    function matches() {
      return filters.every(([column, value]) => {
        if (value === '__not_null__') return row[column] != null;
        if (value === null) return row[column] == null;
        return row[column] === value;
      });
    }
    function run() {
      if (table === 'activity_logs') {
        log.activity.push(payload);
        return { data: [payload], error: null };
      }
      if (op === 'update') {
        if (!matches()) return { data: [], error: null };
        Object.assign(row, payload);
        log.updates.push({ payload, filters });
        return { data: [{ id: row.id }], error: null };
      }
      log.selectFilters.push(filters);
      return { data: [{ ...row }], error: null };
    }
    return api;
  }

  const sb = {
    from(table) {
      return {
        update: payload => query(table, 'update', payload),
        insert: payload => query(table, 'insert', payload),
        select: () => query(table, 'select'),
      };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: { email: 'pro@example.com' } }, error: null }) } },
  };
  return { sb, row, log };
}

// ── A Stripe that answers exactly how the scenario says ─────────────────────
function fakeStripe({ confirm, retrieveStatus = 'requires_confirmation', lastPaymentError = null, existingStatus = null, existingSetupFutureUsage = null }) {
  const calls = { creates: 0, confirms: 0, retrieves: 0, cancels: 0, createParams: [] };
  const intent = status => ({
    id: 'pi_test',
    amount: AMOUNT,
    currency: 'usd',
    customer: 'cus_test',
    payment_method: 'pm_test',
    capture_method: 'manual',
    livemode: true,
    status,
    last_payment_error: status === 'requires_capture' ? null : lastPaymentError,
    metadata: { bookingId: BOOKING_ID, type: 'customer_booking' },
  });
  return {
    calls,
    paymentIntents: {
      async create(params) { calls.creates += 1; calls.createParams.push(params); return intent('requires_confirmation'); },
      async confirm() {
        calls.confirms += 1;
        const answer = typeof confirm === 'function' ? confirm(calls.confirms) : confirm;
        if (answer instanceof Error || answer?.throws) throw (answer.throws || answer);
        return intent(answer);
      },
      async retrieve() {
        calls.retrieves += 1;
        const found = intent(existingStatus || retrieveStatus);
        if (existingSetupFutureUsage) found.setup_future_usage = existingSetupFutureUsage;
        return found;
      },
      async cancel() { calls.cancels += 1; return { ...intent('canceled'), status: 'canceled' }; },
    },
  };
}

function spyNotifiers() {
  const sent = [];
  const record = name => async (...args) => { sent.push({ name, args }); return { ok: true }; };
  return {
    sent,
    names: () => sent.map(s => s.name),
    notify: {
      customerRecovery: async (sb, booking, outcome) => { sent.push({ name: 'customerRecovery', outcome }); return { ok: true }; },
      customerAuthorized: record('customerAuthorized'),
      easerHold: record('easerHold'),
      easerCleared: record('easerCleared'),
      owner: async (booking, message) => { sent.push({ name: 'owner', message }); return { ok: true }; },
    },
  };
}

const connectionError = Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
const cardDecline = Object.assign(new Error('Your card was declined.'), {
  type: 'StripeCardError', code: 'card_declined', decline_code: 'insufficient_funds',
});

// ── 1. Our request never reached Stripe: nobody outside is told ─────────────
{
  const { sb, row } = fakeDb(baseBooking());
  const stripe = fakeStripe({ confirm: { throws: connectionError } });
  const spy = spyNotifiers();

  const result = await authorizeScheduledBooking({
    sb, stripe, booking: baseBooking(), expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(stripe.calls.confirms, 2, 'a dropped request is retried before concluding anything');
  assert.equal(result.retryScheduled, true, 'and the booking is left for the next run');
  assert.ok(!spy.names().includes('customerRecovery'), 'the customer is NOT emailed about our own failure');
  assert.ok(!spy.names().includes('easerHold'), 'the Easer is NOT told to stand down for our own failure');
  assert.deepEqual(spy.names(), ['owner'], 'only the owner hears about it');
  assert.match(spy.sent[0].message, /did not reach Stripe/, 'and is told what actually failed');
  assert.match(spy.sent[0].message, /retries automatically/);
  assert.equal(row.payment_status, 'card_saved', 'the booking stays in the queue the nightly job reads');
  assert.equal(row.stripe_payment_intent_id, null, 'and carries no half-finished PaymentIntent');
  assert.equal(row.financial_operation_key, null, 'the lock is released so the next run can retry');
}

// ── 2. The bank really did ask for the cardholder ───────────────────────────
{
  const { sb, row } = fakeDb(baseBooking());
  const stripe = fakeStripe({ confirm: 'requires_action' });
  const spy = spyNotifiers();

  await authorizeScheduledBooking({
    sb, stripe, booking: baseBooking(), expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.ok(spy.names().includes('customerRecovery'), 'a real authentication request does reach the customer');
  assert.ok(spy.names().includes('easerHold'), 'and the assigned Easer is told');
  const recovery = spy.sent.find(s => s.name === 'customerRecovery');
  assert.equal(recovery.outcome.customerHeadline, 'Your bank needs one more confirmation');
  assert.equal(row.payment_status, 'pending');
  assert.equal(row.dispatch_status, 'payment_hold');
}

// ── 3. The bank refused the card ────────────────────────────────────────────
{
  const { sb } = fakeDb(baseBooking());
  const stripe = fakeStripe({
    confirm: { throws: cardDecline },
    retrieveStatus: 'requires_payment_method',
    lastPaymentError: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' },
  });
  const spy = spyNotifiers();

  await authorizeScheduledBooking({
    sb, stripe, booking: baseBooking(), expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(stripe.calls.confirms, 1, 'a decline is the issuer answering, so it is not retried');
  const recovery = spy.sent.find(s => s.name === 'customerRecovery');
  assert.ok(recovery, 'a decline does reach the customer');
  assert.equal(recovery.outcome.customerHeadline, 'Your bank declined the hold on your card',
    'and says the bank declined it, not that the bank wants a confirmation');
  const owner = spy.sent.find(s => s.name === 'owner');
  assert.match(owner.message, /insufficient_funds/, 'the owner gets the decline code Stripe gave');
}

// ── 4. The happy path still works ───────────────────────────────────────────
{
  const { sb, row } = fakeDb(baseBooking());
  const stripe = fakeStripe({ confirm: 'requires_capture' });
  const spy = spyNotifiers();

  const result = await authorizeScheduledBooking({
    sb, stripe, booking: baseBooking(), expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(result.authorized, true);
  assert.equal(row.payment_status, 'authorized');
  assert.equal(row.dispatch_paused, false, 'dispatch resumes');
  assert.ok(spy.names().includes('customerAuthorized'));
  assert.ok(!spy.names().includes('easerHold'));
}

// ── 5. A hold an earlier run abandoned is finished, not left forever ────────
{
  const stranded = baseBooking({
    payment_status: 'pending',
    dispatch_status: 'payment_hold',
    stripe_payment_intent_id: 'pi_test',
  });
  const { sb, row, log } = fakeDb(stranded);
  const stripe = fakeStripe({ confirm: 'requires_capture', existingStatus: 'requires_confirmation' });
  const spy = spyNotifiers();

  const result = await recoverUnconfirmedHolds({
    sb, stripe, expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(result.authorized, 1, 'the stranded booking is authorized on a later run');
  assert.equal(row.payment_status, 'authorized');
  assert.equal(row.dispatch_status, null);
  assert.equal(row.dispatch_paused, false);
  assert.ok(spy.names().includes('easerCleared'), 'the Easer who was told to stand down is told it cleared');
  // The customer already had one email about this payment. A hold going through
  // is not news she must act on, and the owner asked for no further email on a
  // booking that had six in five days.
  assert.ok(!spy.names().includes('customerAuthorized'), 'the customer is not emailed again when it clears');
  const filters = log.selectFilters[0].map(([column, value]) => `${column}=${value}`);
  assert.ok(filters.includes('payment_status=pending'), 'the sweep looks for exactly the state the old code left behind');
  assert.ok(filters.includes('dispatch_status=payment_hold'));
}

// ── 6. A booking genuinely waiting on the customer is left alone ────────────
{
  const waiting = baseBooking({
    payment_status: 'pending',
    dispatch_status: 'payment_hold',
    stripe_payment_intent_id: 'pi_test',
  });
  const { sb, row, log } = fakeDb(waiting);
  const stripe = fakeStripe({ confirm: 'requires_action', existingStatus: 'requires_action' });
  const spy = spyNotifiers();

  const result = await recoverUnconfirmedHolds({
    sb, stripe, expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(result.authorized, 0);
  assert.equal(stripe.calls.confirms, 0, 'nothing is re-confirmed while the customer still has to act');
  assert.equal(row.payment_status, 'pending', 'and the booking is not touched');
  assert.equal(log.updates.length, 0);
  assert.deepEqual(spy.names(), [], 'and nobody is emailed twice');
}

// ── 7. The hold Stripe will actually accept ─────────────────────────────────
// The live failure on 2026-09-19: the hold was created with
// setup_future_usage: 'off_session' and then confirmed with off_session: true.
// Stripe refuses that pair outright -- "the customer needs to be on-session" --
// so EVERY scheduled hold was rejected at the confirm step and every customer
// was then told their bank wanted another confirmation. The card is already
// saved and attached by the SetupIntent taken at booking; nothing needs setting
// up again.
{
  const { sb } = fakeDb(baseBooking());
  const stripe = fakeStripe({ confirm: 'requires_capture' });
  const spy = spyNotifiers();
  await authorizeScheduledBooking({
    sb, stripe, booking: baseBooking(), expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });
  const created = stripe.calls.createParams[0];
  assert.equal(created.setup_future_usage, undefined,
    'a hold that will be confirmed off-session must not ask Stripe to set the card up again');
  assert.equal(created.capture_method, 'manual', 'it is still a hold, not a charge');
  assert.equal(created.customer, 'cus_test');
  assert.equal(created.payment_method, 'pm_test');
}

// ── 8. A hold created the old way is cancelled and replaced ─────────────────
{
  const stranded = baseBooking({
    payment_status: 'pending',
    dispatch_status: 'payment_hold',
    stripe_payment_intent_id: 'pi_test',
  });
  const { sb, row } = fakeDb(stranded);
  const stripe = fakeStripe({
    confirm: 'requires_capture',
    existingStatus: 'requires_confirmation',
    existingSetupFutureUsage: 'off_session',
  });
  const spy = spyNotifiers();

  const result = await recoverUnconfirmedHolds({
    sb, stripe, expectedLivemode: true, todayIso: '2026-09-19', notify: spy.notify,
  });

  assert.equal(result.authorized, 1, 'the booking ends up authorized');
  assert.equal(stripe.calls.cancels, 1, 'the unconfirmable hold is cancelled, not retried forever');
  assert.equal(stripe.calls.creates, 1, 'and a clean one is created');
  assert.equal(stripe.calls.createParams[0].setup_future_usage, undefined, 'without the parameter that broke it');
  assert.equal(row.payment_status, 'authorized');
  assert.ok(spy.names().includes('easerCleared'), 'the Easer is told it cleared');
  assert.ok(!spy.names().includes('customerAuthorized'), 'and the customer is still not emailed again');
}

// ── 9. The verdict table itself ─────────────────────────────────────────────
{
  const cases = [
    [{ intentStatus: 'requires_capture' }, 'authorized', false],
    [{ intentStatus: 'requires_action' }, 'customer_action', true],
    [{ intentStatus: 'requires_payment_method', lastPaymentError: { code: 'card_declined' } }, 'customer_action', true],
    [{ intentStatus: 'requires_confirmation' }, 'platform_retry', false],
    [{ intentStatus: 'requires_confirmation', confirmError: connectionError }, 'platform_retry', false],
    [{ intentStatus: 'requires_payment_method' }, 'platform_retry', false],
    [{ intentStatus: 'processing' }, 'unexpected', false],
  ];
  for (const [input, kind, notifyCustomer] of cases) {
    const outcome = classifyAuthorizationOutcome(input);
    assert.equal(outcome.kind, kind, `${input.intentStatus} -> ${kind}`);
    assert.equal(outcome.notifyCustomer, notifyCustomer, `${input.intentStatus} customer notification`);
    assert.ok(outcome.ownerReason, 'every verdict states a reason for the owner');
  }
  assert.equal(classifyAuthorizationOutcome({ intentStatus: 'requires_confirmation' }).retryable, true);

  // Stripe answering "no, not like that" is our bug, and must not be described
  // as a request that never arrived.
  const rejected = classifyAuthorizationOutcome({
    intentStatus: 'requires_confirmation',
    confirmError: Object.assign(new Error('You cannot confirm with `off_session=true` when `setup_future_usage` is also set'), {
      type: 'StripeInvalidRequestError',
    }),
  });
  assert.equal(rejected.kind, 'platform_retry');
  assert.equal(rejected.notifyCustomer, false, 'a parameter mistake never reaches the customer');
  assert.match(rejected.ownerReason, /Stripe rejected our confirmation request/);
  assert.match(rejected.ownerReason, /platform fault, not the customer's card/);
  assert.doesNotMatch(rejected.ownerReason, /did not reach Stripe/);
}

console.log('Scheduled authorization truth tests: PASS');
