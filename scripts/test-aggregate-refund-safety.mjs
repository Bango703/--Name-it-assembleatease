import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  bookingPaymentIntentIds,
  loadBookingStripeRefundTruth,
  refundAllRemainingBookingCharges,
  refundPaymentStatus,
} from '../api/booking/_stripe-refund-truth.js';
import { validateBookingPaymentIntentTopology } from '../api/booking/_cancellation-stripe-truth.js';

// These are isolated Stripe fixtures; deployment mode is tested elsewhere.
delete process.env.STRIPE_SECRET_KEY;

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function makeStripe({ intents, charges, refundsByCharge = {}, createPlan = [] }) {
  const intentStore = new Map(Object.entries(clone(intents)));
  const chargeStore = new Map(Object.entries(clone(charges)));
  const refundStore = new Map(
    Object.entries(clone(refundsByCharge)).map(([chargeId, refunds]) => [chargeId, refunds]),
  );
  const calls = { intentRetrieve: [], chargeRetrieve: [], refundList: [], refundCreate: [] };
  let generatedRefundId = 1;

  function chargeForIntent(paymentIntentId) {
    const intent = intentStore.get(paymentIntentId);
    const chargeId = typeof intent?.latest_charge === 'string'
      ? intent.latest_charge
      : intent?.latest_charge?.id;
    return { chargeId, charge: chargeStore.get(chargeId) };
  }

  function refreshChargeRefundTotal(chargeId) {
    const charge = chargeStore.get(chargeId);
    if (!charge) return;
    const refunds = refundStore.get(chargeId) || [];
    charge.amount_refunded = refunds
      .filter(refund => refund.status === 'succeeded')
      .reduce((total, refund) => total + Number(refund.amount || 0), 0);
  }

  return {
    calls,
    paymentIntents: {
      retrieve: async (id, options) => {
        calls.intentRetrieve.push({ id, options });
        if (!intentStore.has(id)) throw new Error(`Unknown intent ${id}`);
        return clone(intentStore.get(id));
      },
    },
    charges: {
      retrieve: async id => {
        calls.chargeRetrieve.push(id);
        if (!chargeStore.has(id)) throw new Error(`Unknown charge ${id}`);
        return clone(chargeStore.get(id));
      },
    },
    refunds: {
      list: async params => {
        calls.refundList.push(clone(params));
        return { data: clone(refundStore.get(params.charge) || []), has_more: false };
      },
      create: async (params, options) => {
        calls.refundCreate.push({ params: clone(params), options: clone(options) });
        const planned = createPlan.shift() || { status: 'succeeded' };
        if (planned.throwBeforeCreate) throw planned.throwBeforeCreate;

        const refund = {
          id: planned.id || `re_generated_${generatedRefundId++}`,
          amount: params.amount,
          status: planned.status || 'succeeded',
          payment_intent: params.payment_intent,
          metadata: params.metadata,
        };
        const { chargeId } = chargeForIntent(params.payment_intent);
        const chargeRefunds = refundStore.get(chargeId) || [];
        chargeRefunds.push(refund);
        refundStore.set(chargeId, chargeRefunds);
        refreshChargeRefundTotal(chargeId);
        if (planned.throwAfterCreate) throw planned.throwAfterCreate;
        return clone(refund);
      },
    },
  };
}

const depositBooking = {
  id: 'booking-aggregate-1',
  ref: 'AAE-AGG-1',
  total_price: 10_000,
  deposit_amount: 2_500,
  is_deposit: true,
  payment_status: 'partially_refunded',
  amount_charged: 10_000,
  stripe_payment_intent_id: 'pi_deposit',
  stripe_deposit_intent_id: 'pi_deposit',
  stripe_balance_payment_intent_id: 'pi_balance',
};

function depositFixture(overrides = {}) {
  return makeStripe({
    intents: {
      pi_deposit: {
        id: 'pi_deposit',
        status: 'succeeded',
        currency: 'usd',
        amount: 2_500,
        amount_received: 2_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking_deposit' },
        latest_charge: 'ch_deposit',
      },
      pi_balance: {
        id: 'pi_balance',
        status: 'succeeded',
        currency: 'usd',
        amount: 7_500,
        amount_received: 7_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking_balance' },
        latest_charge: 'ch_balance',
      },
      ...(overrides.intents || {}),
    },
    charges: {
      ch_deposit: {
        id: 'ch_deposit', payment_intent: 'pi_deposit', currency: 'usd', amount: 2_500,
        amount_captured: 2_500, amount_refunded: 500, captured: true, paid: true, disputed: false,
      },
      ch_balance: {
        id: 'ch_balance', payment_intent: 'pi_balance', currency: 'usd', amount: 7_500,
        amount_captured: 7_500, amount_refunded: 1_000, captured: true, paid: true, disputed: false,
      },
      ...(overrides.charges || {}),
    },
    refundsByCharge: {
      ch_deposit: [{ id: 're_dep_prior', amount: 500, status: 'succeeded' }],
      ch_balance: [{ id: 're_bal_prior', amount: 1_000, status: 'succeeded' }],
      ...(overrides.refundsByCharge || {}),
    },
    createPlan: overrides.createPlan || [],
  });
}

await check('linked intent IDs are deduplicated without losing deposit/balance truth', () => {
  assert.deepEqual(bookingPaymentIntentIds(depositBooking), ['pi_deposit', 'pi_balance']);
  assert.deepEqual(bookingPaymentIntentIds({
    stripe_payment_intent_id: null,
    stripe_deposit_intent_id: 'pi_deposit_only',
    stripe_balance_payment_intent_id: null,
  }), ['pi_deposit_only']);
});

await check('shared topology rejects a distinct full primary plus deposit PaymentIntent', () => {
  assert.throws(
    () => validateBookingPaymentIntentTopology({
      id: 'booking-invalid-primary-deposit',
      total_price: 10_000,
      deposit_amount: 2_500,
      is_deposit: true,
      stripe_payment_intent_id: 'pi_full',
      stripe_deposit_intent_id: 'pi_deposit',
    }, { requireIntent: true }),
    error => error?.code === 'CANCELLATION_PAYMENT_INTENT_MISMATCH'
      && /distinct full primary payment and deposit/i.test(error.message),
  );
});

await check('shared topology rejects a balance PaymentIntent without its deposit', () => {
  assert.throws(
    () => validateBookingPaymentIntentTopology({
      id: 'booking-invalid-balance-only',
      total_price: 10_000,
      deposit_amount: 2_500,
      is_deposit: true,
      stripe_balance_payment_intent_id: 'pi_balance',
    }, { requireIntent: true }),
    error => error?.code === 'CANCELLATION_PAYMENT_INTENT_MISMATCH'
      && /without its linked deposit/i.test(error.message),
  );
});

await check('aggregate truth sums succeeded refunds across deposit and balance charges', async () => {
  const stripe = depositFixture();
  const truth = await loadBookingStripeRefundTruth({ stripe, booking: depositBooking });

  assert.equal(truth.rows.length, 2);
  assert.equal(truth.capturedCents, 10_000);
  assert.equal(truth.refundedCents, 1_500);
  assert.equal(truth.pendingRefundCents, 0);
  assert.equal(truth.remainingRefundableCents, 8_500);
  assert.equal(truth.fullyRefunded, false);
  assert.equal(truth.fullyAllocated, false);
  assert.equal(refundPaymentStatus(truth), 'partially_refunded');
  assert.deepEqual(stripe.calls.refundList, [
    { charge: 'ch_deposit', limit: 100 },
    { charge: 'ch_balance', limit: 100 },
  ]);
});

await check('aggregate captured Stripe amount must equal booking amount_charged', async () => {
  await assert.rejects(
    loadBookingStripeRefundTruth({
      stripe: depositFixture(),
      booking: { ...depositBooking, amount_charged: 9_999 },
    }),
    error => error?.code === 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED',
  );
});

await check('captured charge linkage and capture totals are verified exactly', async () => {
  const invalidChargeCases = [
    {
      label: 'charge payment intent',
      charge: {
        id: 'ch_deposit', payment_intent: 'pi_other', currency: 'usd', amount: 2_500,
        amount_captured: 2_500, amount_refunded: 500, captured: true, paid: true, disputed: false,
      },
    },
    {
      label: 'amount captured',
      charge: {
        id: 'ch_deposit', payment_intent: 'pi_deposit', currency: 'usd', amount: 2_500,
        amount_captured: 2_499, amount_refunded: 500, captured: true, paid: true, disputed: false,
      },
    },
    {
      label: 'disputed charge',
      charge: {
        id: 'ch_deposit', payment_intent: 'pi_deposit', currency: 'usd', amount: 2_500,
        amount_captured: 2_500, amount_refunded: 500, captured: true, paid: true, disputed: true,
      },
    },
  ];
  for (const testCase of invalidChargeCases) {
    await assert.rejects(
      loadBookingStripeRefundTruth({
        stripe: depositFixture({ charges: { ch_deposit: testCase.charge } }),
        booking: depositBooking,
      }),
      error => error?.code === 'STRIPE_REFUND_TRUTH_MISMATCH',
      `${testCase.label} mismatch must fail closed`,
    );
  }
});

await check('pending refunds reserve capacity but never count as succeeded', async () => {
  const booking = {
    id: 'booking-pending-refund',
    ref: 'AAE-PENDING',
    total_price: 1_000,
    payment_status: 'captured',
    amount_charged: 1_000,
    stripe_payment_intent_id: 'pi_pending',
  };
  const stripe = makeStripe({
    intents: {
      pi_pending: {
        id: 'pi_pending',
        status: 'succeeded',
        currency: 'usd',
        amount: 1_000,
        amount_received: 1_000,
        metadata: { bookingId: booking.id, type: 'customer_booking' },
        latest_charge: 'ch_pending',
      },
    },
    charges: {
      // Stripe may expose an amount_refunded that is ahead of succeeded refund
      // objects. The helper must use explicit Refund status as financial truth.
      ch_pending: {
        id: 'ch_pending', payment_intent: 'pi_pending', currency: 'usd', amount: 1_000,
        amount_captured: 1_000, amount_refunded: 400, captured: true, paid: true, disputed: false,
      },
    },
    refundsByCharge: {
      ch_pending: [{ id: 're_pending', amount: 400, status: 'pending' }],
    },
    createPlan: [{ id: 're_remaining', status: 'succeeded' }],
  });

  const before = await loadBookingStripeRefundTruth({ stripe, booking });
  assert.equal(before.refundedCents, 0);
  assert.equal(before.pendingRefundCents, 400);
  assert.equal(before.remainingRefundableCents, 600);
  assert.equal(before.fullyRefunded, false);
  assert.equal(refundPaymentStatus(before), null);

  const result = await refundAllRemainingBookingCharges({
    stripe,
    booking,
    reason: 'full refund requested',
    keyPrefix: 'booking-refund',
  });
  assert.equal(result.after.refundedCents, 600);
  assert.equal(result.after.pendingRefundCents, 400);
  assert.equal(result.after.fullyAllocated, true);
  assert.equal(result.after.fullyRefunded, false, 'a pending remainder must not be reported as a completed refund');
  assert.equal(refundPaymentStatus(result.after), 'partially_refunded');
  assert.equal(stripe.calls.refundCreate[0].params.amount, 600, 'pending refund capacity must not be duplicated');
});

await check('full aggregate refund uses per-intent stable keys and fresh succeeded truth', async () => {
  const stripe = depositFixture({
    createPlan: [
      { id: 're_dep_final', status: 'succeeded' },
      { id: 're_bal_final', status: 'succeeded' },
    ],
  });
  const result = await refundAllRemainingBookingCharges({
    stripe,
    booking: depositBooking,
    reason: 'owner approved',
    keyPrefix: 'booking-refund',
  });

  assert.equal(result.error, null);
  assert.equal(result.after.capturedCents, 10_000);
  assert.equal(result.after.refundedCents, 10_000);
  assert.equal(result.after.pendingRefundCents, 0);
  assert.equal(result.after.fullyRefunded, true);
  assert.equal(refundPaymentStatus(result.after), 'refunded');
  assert.deepEqual(
    stripe.calls.refundCreate.map(call => [
      call.params.payment_intent,
      call.params.amount,
      call.options.idempotencyKey,
    ]),
    [
      ['pi_deposit', 2_000, 'booking-refund-booking-aggregate-1-pi_deposit-total-2500-attempt-1'],
      ['pi_balance', 6_500, 'booking-refund-booking-aggregate-1-pi_balance-total-7500-attempt-1'],
    ],
  );
  for (const call of stripe.calls.refundCreate) {
    assert.equal(call.params.metadata.bookingId, depositBooking.id);
    assert.equal(call.params.metadata.aggregateRefund, 'true');
  }
});

await check('confirmed failed refunds rotate the retry key without weakening amount idempotency', async () => {
  const booking = {
    id: 'booking-retry', ref: 'AAE-RETRY', total_price: 2_000,
    payment_status: 'captured', amount_charged: 2_000, stripe_payment_intent_id: 'pi_retry',
  };
  const stripe = makeStripe({
    intents: {
      pi_retry: {
        id: 'pi_retry', status: 'succeeded', currency: 'usd', amount: 2_000, amount_received: 2_000,
        metadata: { bookingId: booking.id, type: 'customer_booking' }, latest_charge: 'ch_retry',
      },
    },
    charges: { ch_retry: {
      id: 'ch_retry', payment_intent: 'pi_retry', currency: 'usd', amount: 2_000,
      amount_captured: 2_000, amount_refunded: 0, captured: true, paid: true, disputed: false,
    } },
    refundsByCharge: { ch_retry: [{ id: 're_failed', amount: 2_000, status: 'failed' }] },
    createPlan: [{ id: 're_retry_success', status: 'succeeded' }],
  });

  const result = await refundAllRemainingBookingCharges({ stripe, booking, keyPrefix: 'booking-refund' });
  assert.equal(result.after.fullyRefunded, true);
  assert.equal(
    stripe.calls.refundCreate[0].options.idempotencyKey,
    'booking-refund-booking-retry-pi_retry-total-2000-attempt-2',
  );
});

await check('aggregate helper fails closed on exact PaymentIntent linkage and type mismatches', async () => {
  const cases = [
    {
      label: 'returned intent ID',
      mutate: stripe => { stripe.paymentIntents.retrieve = async () => ({
        id: 'pi_wrong', status: 'succeeded', currency: 'usd', amount: 2_500, amount_received: 2_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking_deposit' }, latest_charge: 'ch_deposit',
      }); },
    },
    {
      label: 'booking metadata',
      overrides: { intents: { pi_deposit: {
        id: 'pi_deposit', status: 'succeeded', currency: 'usd', amount: 2_500, amount_received: 2_500,
        metadata: { bookingId: 'booking-other', type: 'customer_booking_deposit' }, latest_charge: 'ch_deposit',
      } } },
    },
    {
      label: 'balance type',
      overrides: { intents: { pi_balance: {
        id: 'pi_balance', status: 'succeeded', currency: 'usd', amount: 7_500, amount_received: 7_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking' }, latest_charge: 'ch_balance',
      } } },
    },
    {
      label: 'currency',
      overrides: { intents: { pi_deposit: {
        id: 'pi_deposit', status: 'succeeded', currency: 'eur', amount: 2_500, amount_received: 2_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking_deposit' }, latest_charge: 'ch_deposit',
      } } },
    },
  ];

  for (const testCase of cases) {
    const stripe = depositFixture(testCase.overrides || {});
    testCase.mutate?.(stripe);
    await assert.rejects(
      loadBookingStripeRefundTruth({ stripe, booking: depositBooking }),
      error => error.code === 'STRIPE_REFUND_TRUTH_MISMATCH',
      `${testCase.label} mismatch must fail closed`,
    );
  }
});

await check('refund pagination fails closed instead of undercounting aggregate truth', async () => {
  const stripe = depositFixture();
  stripe.refunds.list = async params => ({
    data: params.charge === 'ch_deposit' ? [{ id: 're_dep_prior', amount: 500, status: 'succeeded' }] : [],
    has_more: true,
  });
  await assert.rejects(
    loadBookingStripeRefundTruth({ stripe, booking: depositBooking }),
    error => error.code === 'STRIPE_REFUND_PAGINATION_REQUIRED',
  );
});

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [refundEndpoint, webhook, refundHelper, operationHelper, refundCredits, migration037] = await Promise.all([
  load('api/booking/refund.js'),
  load('api/assembler/stripe-webhook.js'),
  load('api/booking/_stripe-refund-truth.js'),
  load('api/booking/_financial-operation.js'),
  load('api/booking/_refund-credits.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
]);

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

await check('source requires explicit succeeded refund truth and keeps pending capacity locked', () => {
  assert.match(refundHelper, /stripe\.refunds\.list\(\{ charge: charge\.id, limit: 100 \}\)/);
  assert.match(refundHelper, /refund\.status === 'succeeded'/);
  assert.match(refundHelper, /pendingRefundCents/);
  assert.match(refundHelper, /capturedCents - refundedCents - pendingRefundCents/);
  assert.match(refundEndpoint, /refundObjects\.every\(refund => refund\.status === 'succeeded'\)/);
  assert.match(
    refundEndpoint,
    /if \(!aggregateRefund\.after\.fullyRefunded \|\| !allAttemptedRefundsSucceeded\)/,
  );
  assert.ok(
    refundEndpoint.indexOf('if (!aggregateRefund.after.fullyRefunded || !allAttemptedRefundsSucceeded)')
      < refundEndpoint.indexOf('const paymentStatus = cumulativeRefundCents'),
    'the endpoint must exit pending/failed refund paths before persisting refunded state',
  );
});

await check('capture webhooks cannot regress partially refunded or adopt stale PaymentIntents', () => {
  const captureSync = between(webhook, 'async function syncCapturedCustomerPayment', 'function buildCustomerReceiptEmail');
  assert.match(captureSync, /refundProtectedStatuses = \['refund_pending', 'partially_refunded', 'refunded'\]/);
  assert.match(captureSync, /current\.stripe_payment_intent_id !== pi\.id/);
  assert.match(captureSync, /\.eq\('stripe_payment_intent_id', pi\.id\)/);
  assert.match(captureSync, /current\.stripe_balance_payment_intent_id && current\.stripe_balance_payment_intent_id !== pi\.id/);
  assert.match(captureSync, /\.not\('payment_status', 'in', '\(refund_pending,partially_refunded,refunded\)'\)/);
  assert.match(captureSync, /stale-capture-after-stripe-refund/);
});

await check('owner refund lock snapshots every linked PaymentIntent with null-safe CAS', () => {
  const reserve = between(refundEndpoint, 'async function reserveRefundOperation', null);
  assert.match(reserve, /reserveBookingFinancialOperation\(sb, \{/);
  assert.match(reserve, /expectedBooking: booking/);
  for (const field of [
    'stripe_payment_intent_id',
    'stripe_deposit_intent_id',
    'stripe_balance_payment_intent_id',
  ]) {
    assert.match(
      operationHelper,
      new RegExp(`${field}: expectedBooking\\.${field} \\?\\? null`),
      `${field} needs an exact nullable financial snapshot`,
    );
  }
});

await check('failed refund webhook cannot release an owner lock from a delayed prior attempt', () => {
  const failedRefund = between(webhook, "case 'refund.failed':", "case 'charge.refunded':");
  assert.doesNotMatch(
    failedRefund,
    /releaseBookingFinancialOperation/,
    'a delayed failure is not bound to the active retry, which reuses the deterministic aggregate lock key',
  );
  assert.match(failedRefund, /lock remains unchanged/i);
  assert.match(failedRefund, /releasedLock: false/);
});

await check('charge.refunded synchronization is aggregate, monotonic, and exact-CAS guarded', () => {
  const chargeRefunded = between(webhook, "case 'charge.refunded':", "case 'charge.dispute.created':");
  assert.match(chargeRefunded, /loadBookingStripeRefundTruth\(\{ stripe, booking \}\)/);
  assert.match(chargeRefunded, /if \(storedRefund > cumulativeRefund\)/);
  assert.match(chargeRefunded, /refundPaymentStatus\(stripeTruth\)/);
  assert.match(chargeRefunded, /refundUpdateQuery\.eq\('refund_amount', booking\.refund_amount\)/);
  assert.match(chargeRefunded, /booking\.financial_operation_key === expectedRefundOperationKey/);
  assert.match(chargeRefunded, /idempotencyKey: `refund-sync:\$\{booking\.id\}:total:\$\{cumulativeRefund\}`/);
});

await check('owner refund clawback audit is idempotent by aggregate refund total', () => {
  const clawbackMatches = [...refundEndpoint.matchAll(/eventType: 'clawback_required'/g)];
  assert.ok(clawbackMatches.length >= 2, 'both recovery and new-refund clawback paths must be covered');
  for (const match of clawbackMatches) {
    const block = refundEndpoint.slice(match.index, match.index + 900);
    assert.match(block, /idempotencyKey:/, 'every clawback audit write needs an idempotency key');
  }
  const aggregateKeys = refundEndpoint.match(/`clawback:\$\{booking\.id\}:refund-total:\$\{[^}]+\}`/g) || [];
  assert.ok(aggregateKeys.length >= 2, 'both clawback paths must derive identity from aggregate refund truth');
  const synchronizedRecovery = between(
    refundEndpoint,
    '// A webhook may have synchronized Stripe truth',
    '// Recover safely from a prior Stripe-success/DB-failure',
  );
  const synchronizedClawbackIndex = synchronizedRecovery.indexOf('await ensureClawbackAudit');
  const synchronizedReleaseIndex = synchronizedRecovery.indexOf('await finalizeRefundReconciliation');
  assert.ok(synchronizedClawbackIndex >= 0 && synchronizedReleaseIndex > synchronizedClawbackIndex,
    'an exact-lock retry must persist any post-payout clawback before releasing the refund hold');
});

await check('refund recovery never silently ignores an AssembleCash reversal failure', () => {
  assert.match(refundEndpoint, /await reconcileRefundAssembleCash\(\{/);
  assert.match(refundCredits, /reconcileBookingCredits\(sb, \{/);
  assert.match(refundCredits, /releaseRedemption: !!fullyRefunded/);
  assert.match(refundCredits, /eventType: 'assemblecash_reversal_required'/);
  assert.match(refundEndpoint, /REFUND_REWARDS_RECONCILIATION_REQUIRED/);
  assert.match(refundEndpoint, /await finalizeRefundReconciliation\(sb, booking\.id, operationKey\)/);
  const persistRefundIndex = refundEndpoint.indexOf(".eq('financial_operation_type', 'refund_owner')");
  const rewardsIndex = refundEndpoint.indexOf('rewardsReversal = await reconcileRefundAssembleCash', persistRefundIndex);
  const releaseIndex = refundEndpoint.indexOf('await finalizeRefundReconciliation', rewardsIndex);
  assert.ok(persistRefundIndex >= 0 && rewardsIndex > persistRefundIndex && releaseIndex > rewardsIndex,
    'refund state, serialized rewards reconciliation, and exact lock release must stay ordered');
  assert.match(webhook, /assemblecash-refund-reconciliation-required/);
  assert.match(webhook, /Refund lock release failed after rewards reconciliation/);
});

await check('migration 037 makes refund_owner a valid financial reservation RPC type', () => {
  const reserveRpc = between(
    migration037,
    'CREATE OR REPLACE FUNCTION public.reserve_booking_financial_operation',
    'REVOKE ALL ON FUNCTION public.reserve_booking_financial_operation',
  );
  assert.match(reserveRpc, /'refund_owner'/);
  assert.match(reserveRpc, /p_expected_financial_snapshot/);
});

if (failures.length) {
  console.error(`\nAggregate refund safety checks failed: ${failures.length}`);
  for (const { name, error } of failures) {
    console.error(`- ${name}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log('\nAggregate refund truth, event-order, and lock safety checks passed.');
}
