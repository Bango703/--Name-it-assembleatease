import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isAmbiguousStripeMutationError,
  processBookingReauthorization,
  stripeLivemodeForSecret,
  validateReauthorizationIntent,
} from '../api/cron/reauth-payments.js';

const NOW = '2026-07-14T10:00:00.000Z';

function booking(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ref: 'AAE-REAUTH1',
    service: 'Furniture assembly',
    customer_name: 'Test Customer',
    customer_email: 'customer@example.com',
    status: 'confirmed',
    payment_status: 'authorized',
    date: '2026-07-19',
    time: '9:00 AM - 11:00 AM',
    assembler_id: '22222222-2222-4222-8222-222222222222',
    total_price: 12_500,
    tax_amount: 0,
    service_call_fee: 0,
    amount_charged: 0,
    refund_amount: 0,
    is_deposit: false,
    deposit_amount: 0,
    cancellation_fee: 0,
    stripe_customer_id: 'cus_test',
    stripe_payment_intent_id: 'pi_old',
    stripe_deposit_intent_id: null,
    stripe_balance_payment_intent_id: null,
    stripe_balance_amount_captured: 0,
    payout_status: null,
    payout_amount: 0,
    payout_mode_snapshot: null,
    payout_review_status: 'not_required',
    paid_out_at: null,
    stripe_transfer_id: null,
    assembler_due: 0,
    cancellation_easer_payout_status: null,
    cancellation_easer_due_cents: 0,
    assemblecash_redeemed_cents: 0,
    reschedule_count: 0,
    rescheduled_at: null,
    easer_fee_snapshot_easer_id: null,
    easer_fee_pct_snapshot: null,
    easer_estimated_due_snapshot: null,
    payment_authorized_at: '2026-07-12T10:00:00.000Z',
    financial_operation_key: null,
    financial_operation_type: null,
    financial_operation_started_at: null,
    financial_reconciliation_required_at: null,
    financial_reconciliation_reason: null,
    ...overrides,
  };
}

function paymentIntent(id, overrides = {}) {
  return {
    id,
    status: 'requires_capture',
    capture_method: 'manual',
    amount: 12_500,
    amount_capturable: 12_500,
    currency: 'usd',
    customer: 'cus_test',
    payment_method: 'pm_test',
    livemode: false,
    metadata: {
      bookingId: '11111111-1111-4111-8111-111111111111',
      bookingRef: 'AAE-REAUTH1',
      type: 'customer_booking',
    },
    ...overrides,
  };
}

function fakeSupabase(initialBooking, events, { rejectLink = false } = {}) {
  const state = { booking: structuredClone(initialBooking) };

  const matches = filters => filters.every(({ kind, field, value }) => {
    if (kind === 'is') return state.booking[field] == null && value == null;
    return state.booking[field] === value;
  });

  const filterable = (filters, terminal) => ({
    eq(field, value) { filters.push({ kind: 'eq', field, value }); return this; },
    is(field, value) { filters.push({ kind: 'is', field, value }); return this; },
    select: terminal,
    maybeSingle: terminal,
  });

  const sb = {
    state,
    async rpc(name, args) {
      assert.equal(name, 'reserve_booking_financial_operation');
      events.push('reserve');
      assert.equal(args.p_operation_key, `reauth:${initialBooking.id}`);
      assert.equal(args.p_operation_type, 'reauth_payment');
      const row = state.booking;
      if (row.financial_operation_key && row.financial_operation_key !== args.p_operation_key) {
        return { data: null, error: { code: '55P03', message: 'Another financial operation is already in progress' } };
      }
      row.financial_operation_key = args.p_operation_key;
      row.financial_operation_type = args.p_operation_type;
      row.financial_operation_started_at ||= NOW;
      return { data: [{ booking_id: row.id }], error: null };
    },
    from(table) {
      assert.equal(table, 'bookings');
      return {
        update(payload) {
          const filters = [];
          return filterable(filters, async () => {
            const isLink = Object.hasOwn(payload, 'stripe_payment_intent_id')
              && payload.stripe_payment_intent_id !== state.booking.stripe_payment_intent_id;
            events.push(isLink ? 'db-link' : Object.hasOwn(payload, 'financial_reconciliation_reason') ? 'db-reconcile' : 'db-release');
            if (!matches(filters) || (rejectLink && isLink)) return { data: [], error: null };
            Object.assign(state.booking, payload);
            return { data: [{ id: state.booking.id }], error: null };
          });
        },
        select() {
          const filters = [];
          return filterable(filters, async () => ({
            data: matches(filters) ? structuredClone(state.booking) : null,
            error: null,
          }));
        },
      };
    },
  };
  return sb;
}

function fakeStripe(events, {
  intents = [paymentIntent('pi_old')],
  createError = null,
  cancelOldFails = false,
} = {}) {
  const byId = new Map(intents.map(intent => [intent.id, structuredClone(intent)]));
  let createAttempts = 0;
  const stripe = {
    state: byId,
    paymentIntents: {
      async retrieve(id) {
        events.push(`retrieve:${id}`);
        const intent = byId.get(id);
        if (!intent) throw new Error(`Missing test PaymentIntent ${id}`);
        return structuredClone(intent);
      },
      async create(params, options) {
        events.push('create');
        createAttempts++;
        if (createError) throw typeof createError === 'function' ? createError(createAttempts) : createError;
        const created = paymentIntent('pi_new', {
          amount: params.amount,
          currency: params.currency,
          customer: params.customer,
          payment_method: params.payment_method,
          capture_method: params.capture_method,
          metadata: { ...params.metadata },
        });
        assert.equal(options.idempotencyKey, 'booking-reauth-11111111-1111-4111-8111-111111111111-pi_old-20260714T100000000Z');
        byId.set(created.id, created);
        return structuredClone(created);
      },
      async cancel(id) {
        events.push(`cancel:${id}`);
        if (cancelOldFails && id === 'pi_old') throw new Error('simulated cancellation timeout');
        const intent = byId.get(id);
        if (!intent) throw new Error(`Missing test PaymentIntent ${id}`);
        intent.status = 'canceled';
        intent.amount_capturable = 0;
        return structuredClone(intent);
      },
    },
  };
  return stripe;
}

assert.equal(stripeLivemodeForSecret('sk_test_example'), false);
assert.equal(stripeLivemodeForSecret('rk_live_example'), true);
assert.equal(stripeLivemodeForSecret('not-a-stripe-key'), null);
assert.equal(isAmbiguousStripeMutationError({ type: 'StripeConnectionError' }), true);
assert.equal(isAmbiguousStripeMutationError({ type: 'StripeCardError', code: 'card_declined' }), false);

const validNew = paymentIntent('pi_new', {
  metadata: {
    bookingId: '11111111-1111-4111-8111-111111111111',
    bookingRef: 'AAE-REAUTH1',
    type: 'customer_booking',
    reauthorized: 'true',
    originalPaymentType: 'customer_booking',
    replacesPaymentIntentId: 'pi_old',
  },
});
assert.deepEqual(validateReauthorizationIntent(validNew, {
  booking: booking(),
  expectedId: 'pi_new',
  expectedType: 'customer_booking',
  expectedLivemode: false,
  expectedPaymentMethodId: 'pm_test',
  replacesPaymentIntentId: 'pi_old',
  requireReauthorizationMetadata: true,
}), { ok: true, errors: [] });
const invalid = validateReauthorizationIntent({ ...validNew, currency: 'eur', livemode: true, customer: 'cus_other' }, {
  booking: booking(),
  expectedId: 'pi_new',
  expectedType: 'customer_booking',
  expectedLivemode: false,
  replacesPaymentIntentId: 'pi_old',
  requireReauthorizationMetadata: true,
});
assert.equal(invalid.ok, false);
assert.ok(invalid.errors.includes('currency'));
assert.ok(invalid.errors.includes('customer'));
assert.ok(invalid.errors.includes('livemode'));

{
  const events = [];
  const row = booking();
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events);
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(events[0], 'reserve', 'the database reservation must precede every Stripe call');
  assert.equal(events[1], 'retrieve:pi_old');
  assert.equal(sb.state.booking.stripe_payment_intent_id, 'pi_new');
  assert.equal(sb.state.booking.financial_operation_key, null);
  assert.equal(stripe.state.get('pi_old').status, 'canceled');
}

{
  const events = [];
  const row = booking();
  const sb = fakeSupabase(row, events, { rejectLink: true });
  const stripe = fakeStripe(events);
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reauth_database_link_conflict');
  assert.equal(stripe.state.get('pi_new').status, 'canceled', 'a proven-unlinked replacement hold must be cancelled');
  assert.equal(stripe.state.get('pi_old').status, 'requires_capture', 'the original authorization must remain untouched');
  assert.equal(sb.state.booking.financial_operation_key, null, 'safe link conflict must release only the exact lock');
}

{
  const events = [];
  const row = booking();
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, {
    createError: { type: 'StripeCardError', code: 'card_declined', message: 'declined' },
  });
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'card_declined');
  assert.equal(sb.state.booking.financial_operation_key, null, 'definitive creation failure must release the exact lock');
  assert.equal(stripe.state.get('pi_old').status, 'requires_capture');
}

{
  const events = [];
  const row = booking();
  const failedIntent = paymentIntent('pi_failed', {
    status: 'requires_action',
    amount_capturable: 0,
    metadata: {
      bookingId: row.id,
      bookingRef: row.ref,
      type: 'customer_booking',
      reauthorized: 'true',
      originalPaymentType: 'customer_booking',
      replacesPaymentIntentId: 'pi_old',
    },
  });
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, {
    intents: [paymentIntent('pi_old'), failedIntent],
    createError: {
      type: 'StripeCardError',
      code: 'authentication_required',
      message: 'customer authentication required',
      payment_intent: 'pi_failed',
    },
  });
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authentication_required');
  assert.equal(result.authenticationRequired, true);
  assert.equal(stripe.state.get('pi_failed').status, 'canceled', 'a failed created intent must be cancelled before releasing the lock');
  assert.equal(sb.state.booking.financial_operation_key, null);
}

{
  const events = [];
  const row = booking();
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, {
    createError: () => ({ type: 'StripeConnectionError', message: 'network timeout' }),
  });
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reauth_create_outcome_unconfirmed');
  assert.equal(events.filter(event => event === 'create').length, 2, 'ambiguous creation must retry with the same idempotency key');
  assert.equal(sb.state.booking.financial_operation_key, `reauth:${row.id}`);
  assert.equal(sb.state.booking.financial_reconciliation_reason, 'reauth_create_outcome_unconfirmed');
}

{
  const events = [];
  const row = booking({
    stripe_payment_intent_id: 'pi_new',
    payment_authorized_at: NOW,
    financial_operation_key: 'reauth:11111111-1111-4111-8111-111111111111',
    financial_operation_type: 'reauth_payment',
    financial_operation_started_at: '2026-07-14T09:59:00.000Z',
  });
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, { intents: [paymentIntent('pi_old'), validNew] });
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true, 'a linked replacement with an exact lock must resume old-hold release');
  assert.equal(events.includes('create'), false, 'linked recovery must not create another authorization');
  assert.equal(stripe.state.get('pi_old').status, 'canceled');
  assert.equal(sb.state.booking.financial_operation_key, null);
}

{
  const events = [];
  const row = booking({
    stripe_payment_intent_id: 'pi_new',
    payment_authorized_at: NOW,
  });
  const alreadyCancelledOld = paymentIntent('pi_old', { status: 'canceled', amount_capturable: 0 });
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, { intents: [alreadyCancelledOld, validNew] });
  const result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyComplete, true, 'a second cron invocation must recognize the recently completed reauthorization');
  assert.equal(events.includes('create'), false, 'a repeated cron invocation must not place another card hold');
  assert.equal(sb.state.booking.financial_operation_key, null);
}

{
  const events = [];
  const row = booking();
  const sb = fakeSupabase(row, events);
  const stripe = fakeStripe(events, { cancelOldFails: true });
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await processBookingReauthorization({ sb, stripe, booking: row, expectedLivemode: false, nowIso: NOW });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'reauth_old_hold_release_unconfirmed');
  assert.equal(sb.state.booking.stripe_payment_intent_id, 'pi_new');
  assert.equal(sb.state.booking.financial_operation_key, `reauth:${row.id}`);
  assert.equal(sb.state.booking.financial_reconciliation_reason, 'reauth_old_hold_release_unconfirmed');
}

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [reauthSource, connectLinkSource, connectLoginSource] = await Promise.all([
  load('api/cron/reauth-payments.js'),
  load('api/assembler/connect-link.js'),
  load('api/assembler/connect-login.js'),
]);
const processStart = reauthSource.indexOf('export async function processBookingReauthorization');
const processSource = reauthSource.slice(processStart);
assert.ok(processSource.indexOf('reserveBookingFinancialOperation') < processSource.indexOf('stripe.paymentIntents.retrieve'));
assert.match(processSource, /const operationKey = `reauth:\$\{booking\.id\}`/);
assert.match(processSource, /operationType: REAUTH_OPERATION_TYPE/);
assert.match(processSource, /\.eq\('status', 'confirmed'\)/);
assert.match(processSource, /\.eq\('payment_status', 'authorized'\)/);
assert.match(processSource, /\.eq\('date', booking\.date\)/);
assert.match(processSource, /\.eq\('stripe_payment_intent_id', oldPaymentIntentId\)/);
assert.match(processSource, /\.eq\('financial_operation_key', operationKey\)/);
assert.match(processSource, /\.eq\('financial_operation_started_at', booking\.financial_operation_started_at\)/);
assert.match(processSource, /financial_reconciliation_required_at/);
assert.match(reauthSource, /financial_operation_type\.eq\.\$\{REAUTH_OPERATION_TYPE\}/, 'locked retries must remain queryable after the target day');
for (const source of [connectLinkSource, connectLoginSource]) {
  assert.match(source, /account_closure_status/);
  assert.match(source, /isEaserClosureBlocking\(profile\)/);
  assert.match(source, /ACCOUNT_CLOSURE_BLOCKS_PAYOUT_SETUP/);
}

console.log('reauth payment reservation and recovery safety tests: PASS');
