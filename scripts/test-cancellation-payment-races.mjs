import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fullyRefundCapturedIntent } from '../api/booking/cancel.js';
import {
  isUnrefundedCancellationFeeCapture,
  loadBookingCancellationPaymentIntents,
  validateBookingPaymentIntentTopology,
} from '../api/booking/_cancellation-stripe-truth.js';
import {
  OWNER_CANCELLATION_TAKEOVER_DELAY_MS,
  assertCancellationPayoutUnsettled,
  cancellationPolicyEvaluationTimeMs,
  hasDurableCancellationFeeCaptureAudit,
  resolveOwnerCancellationReservation,
} from '../api/booking/_cancellation-operation.js';
import { claimBookingCancellationRecovery } from '../api/booking/_financial-operation.js';
import { bookingEmailMatches } from '../api/booking/_guest-booking-auth.js';
import { customerOwnsBooking } from '../api/booking/_customer-booking-auth.js';

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

function refundStripe({ existing = [], created = null, hasMore = false } = {}) {
  const calls = [];
  return {
    calls,
    refunds: {
      list: async args => {
        calls.push({ action: 'list', args });
        return { data: existing, has_more: hasMore };
      },
      create: async (payload, options) => {
        calls.push({ action: 'create', payload, options });
        return created;
      },
    },
  };
}

function cancellationStripe({ booking, intent = {}, charge = {}, refunds = [] }) {
  const paymentIntentId = booking.stripe_payment_intent_id;
  const chargeId = 'ch_cancel_fee';
  const canonicalIntent = {
    id: paymentIntentId,
    status: 'succeeded',
    currency: 'usd',
    amount: booking.total_price,
    amount_received: 1_000,
    capture_method: 'manual',
    metadata: { bookingId: booking.id, type: 'customer_booking' },
    latest_charge: chargeId,
    customer: booking.stripe_customer_id || null,
    livemode: false,
    ...intent,
  };
  const canonicalCharge = {
    id: chargeId,
    payment_intent: paymentIntentId,
    currency: 'usd',
    amount: booking.total_price,
    amount_captured: canonicalIntent.amount_received,
    amount_refunded: 0,
    refunded: false,
    captured: true,
    paid: true,
    disputed: false,
    customer: booking.stripe_customer_id || null,
    livemode: false,
    ...charge,
  };
  return {
    paymentIntents: {
      retrieve: async id => {
        assert.equal(id, paymentIntentId);
        return structuredClone(canonicalIntent);
      },
    },
    charges: {
      retrieve: async id => {
        assert.equal(id, chargeId);
        return structuredClone(canonicalCharge);
      },
    },
    refunds: {
      list: async params => {
        assert.equal(params.charge, chargeId);
        return { data: structuredClone(refunds), has_more: false };
      },
    },
  };
}

const refundBooking = { id: 'booking-cancel-race', ref: 'AAE-RACE-1' };
const refundRow = {
  paymentIntentId: 'pi_cancel_race',
  intent: { status: 'succeeded', amount_received: 10_000 },
};

await check('pending cancellation refund is recovered without a duplicate refund', async () => {
  const stripe = refundStripe({
    existing: [{ id: 're_pending', amount: 10_000, status: 'pending' }],
  });
  const result = await fullyRefundCapturedIntent(stripe, {
    booking: refundBooking,
    row: refundRow,
    reason: 'owner_cancelled_post_capture',
    keyPrefix: 'owner-cancel-refund',
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.refundedCents, 0);
  assert.equal(stripe.calls.some(call => call.action === 'create'), false);
});

await check('settled cancellation refund is idempotently recovered', async () => {
  const stripe = refundStripe({
    existing: [{ id: 're_succeeded', amount: 10_000, status: 'succeeded' }],
  });
  const result = await fullyRefundCapturedIntent(stripe, {
    booking: refundBooking,
    row: refundRow,
    reason: 'owner_cancelled_post_capture',
    keyPrefix: 'owner-cancel-refund',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.refundedCents, 10_000);
  assert.equal(stripe.calls.some(call => call.action === 'create'), false);
});

await check('partial cancellation refund only refunds the remaining capture', async () => {
  const stripe = refundStripe({
    existing: [{ id: 're_partial', amount: 2_500, status: 'succeeded' }],
    created: { id: 're_remaining', amount: 7_500, status: 'succeeded' },
  });
  const result = await fullyRefundCapturedIntent(stripe, {
    booking: refundBooking,
    row: refundRow,
    reason: 'owner_cancelled_post_capture',
    keyPrefix: 'owner-cancel-refund',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.refundedCents, 10_000);
  assert.equal(stripe.calls.find(call => call.action === 'create').payload.amount, 7_500);
});

await check('wrong Stripe refund amount fails closed', async () => {
  const stripe = refundStripe({
    created: { id: 're_wrong_amount', amount: 9_999, status: 'succeeded' },
  });
  await assert.rejects(
    fullyRefundCapturedIntent(stripe, {
      booking: refundBooking,
      row: refundRow,
      reason: 'owner_cancelled_post_capture',
      keyPrefix: 'owner-cancel-refund',
    }),
    error => error?.code === 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED',
  );
});

await check('invalid distinct full-primary and deposit topology fails before Stripe mutation', () => {
  assert.throws(
    () => validateBookingPaymentIntentTopology({
      id: 'booking-invalid-topology',
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

await check('balance without a deposit PaymentIntent fails before Stripe mutation', () => {
  assert.throws(
    () => validateBookingPaymentIntentTopology({
      id: 'booking-balance-only',
      total_price: 10_000,
      deposit_amount: 2_500,
      is_deposit: true,
      stripe_balance_payment_intent_id: 'pi_balance',
    }, { requireIntent: true }),
    error => error?.code === 'CANCELLATION_PAYMENT_INTENT_MISMATCH'
      && /without its linked deposit/i.test(error.message),
  );
});

const feeBooking = {
  id: 'booking-fee-recovery',
  ref: 'AAE-FEE-1',
  total_price: 10_000,
  payment_status: 'pending',
  stripe_payment_intent_id: 'pi_fee_recovery',
  stripe_customer_id: 'cus_fee_recovery',
};

await check('shared charge truth accepts only an unrefunded cancellation fee capture', async () => {
  const [row] = await loadBookingCancellationPaymentIntents(
    cancellationStripe({ booking: feeBooking }),
    feeBooking,
  );
  assert.equal(isUnrefundedCancellationFeeCapture(row, feeBooking, 1_000), true);

  assert.equal(isUnrefundedCancellationFeeCapture({
    ...row,
    succeededRefundCents: 1,
  }, feeBooking, 1_000), false);
  assert.equal(isUnrefundedCancellationFeeCapture({
    ...row,
    pendingRefundCents: 1,
  }, feeBooking, 1_000), false);
  assert.equal(isUnrefundedCancellationFeeCapture({
    ...row,
    chargeRefundedCents: 1,
    charge: { ...row.charge, amount_refunded: 1 },
  }, feeBooking, 1_000), false);
});

await check('succeeded and pending Stripe refunds both reject stale fee recovery', async () => {
  const [refundedRow] = await loadBookingCancellationPaymentIntents(
    cancellationStripe({
      booking: feeBooking,
      charge: { amount_refunded: 1_000, refunded: true },
      refunds: [{ id: 're_fee_refunded', amount: 1_000, status: 'succeeded', charge: 'ch_cancel_fee' }],
    }),
    feeBooking,
  );
  assert.equal(refundedRow.chargeRefundedCents, 1_000);
  assert.equal(isUnrefundedCancellationFeeCapture(refundedRow, feeBooking, 1_000), false);

  const [pendingRow] = await loadBookingCancellationPaymentIntents(
    cancellationStripe({
      booking: feeBooking,
      charge: { amount_refunded: 1_000, refunded: true },
      refunds: [{ id: 're_fee_pending', amount: 1_000, status: 'pending', charge: 'ch_cancel_fee' }],
    }),
    feeBooking,
  );
  assert.equal(pendingRow.pendingRefundCents, 1_000);
  assert.equal(pendingRow.chargeRefundedCents, 1_000);
  assert.equal(isUnrefundedCancellationFeeCapture(pendingRow, feeBooking, 1_000), false);
});

await check('charge amount_refunded without matching Refund truth fails closed', async () => {
  await assert.rejects(
    loadBookingCancellationPaymentIntents(
      cancellationStripe({ booking: feeBooking, charge: { amount_refunded: 1_000, refunded: true } }),
      feeBooking,
    ),
    error => error?.code === 'CANCELLATION_REFUND_RECONCILIATION_REQUIRED',
  );
});

await check('aggregate Stripe capture must match booking amount_charged', async () => {
  const booking = {
    ...feeBooking,
    payment_status: 'captured',
    amount_charged: 999,
  };
  await assert.rejects(
    loadBookingCancellationPaymentIntents(
      cancellationStripe({ booking, intent: { amount_received: 1_000 }, charge: { amount_captured: 1_000 } }),
      booking,
    ),
    error => error?.code === 'CANCELLATION_CAPTURE_RECONCILIATION_REQUIRED',
  );
});

await check('policy time remains anchored to the matching financial operation start', () => {
  const startedAt = '2026-07-14T12:00:00.000Z';
  const startedAtMs = Date.parse(startedAt);
  const booking = {
    id: 'booking-policy-clock',
    financial_operation_type: 'cancel_customer',
    financial_operation_key: 'cancel:customer:booking-policy-clock',
    financial_operation_started_at: startedAt,
  };
  assert.equal(cancellationPolicyEvaluationTimeMs(booking, startedAtMs + 1_000), startedAtMs);
  assert.equal(cancellationPolicyEvaluationTimeMs(booking, startedAtMs + 60_000), startedAtMs);
  assert.equal(cancellationPolicyEvaluationTimeMs({
    ...booking,
    financial_operation_key: 'cancel:guest:booking-policy-clock',
  }, startedAtMs + 60_000), startedAtMs + 60_000);
});

await check('owner takeover requires a stale durable hold and rotates to the owner key', () => {
  const nowMs = Date.parse('2026-07-14T13:00:00.000Z');
  const eligible = {
    id: 'booking-owner-recovery',
    financial_operation_type: 'cancel_guest',
    financial_operation_key: 'cancel:guest:booking-owner-recovery',
    financial_operation_started_at: new Date(nowMs - OWNER_CANCELLATION_TAKEOVER_DELAY_MS - 1).toISOString(),
    cancellation_reconciliation_required_at: new Date(nowMs - OWNER_CANCELLATION_TAKEOVER_DELAY_MS - 1).toISOString(),
    dispatch_status: 'payment_hold',
    dispatch_paused: true,
  };
  assert.deepEqual(resolveOwnerCancellationReservation(eligible, nowMs), {
    operationKey: 'cancel:owner:booking-owner-recovery',
    operationType: 'cancel_owner',
    takeover: true,
    expectedOperationKey: 'cancel:guest:booking-owner-recovery',
  });
  assert.throws(
    () => resolveOwnerCancellationReservation({
      ...eligible,
      cancellation_reconciliation_required_at: new Date(nowMs - OWNER_CANCELLATION_TAKEOVER_DELAY_MS + 1).toISOString(),
    }, nowMs),
    error => error?.code === 'FINANCIAL_OPERATION_CONFLICT',
  );
});

await check('owner recovery invokes the atomic database claim with exact old and new keys', async () => {
  const calls = [];
  const sb = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ booking_id: 'booking-rpc', operation_key: args.p_owner_operation_key }], error: null };
    },
  };
  const booking = {
    id: 'booking-rpc',
    status: 'confirmed',
    assembler_id: null,
    date: '2026-07-15',
    time: '10:00',
    payment_status: 'authorized',
    total_price: 10_000,
  };
  await claimBookingCancellationRecovery(sb, {
    booking,
    expectedOperationKey: 'cancel:customer:booking-rpc',
    ownerOperationKey: 'cancel:owner:booking-rpc',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'claim_booking_cancellation_recovery');
  assert.equal(calls[0].args.p_expected_operation_key, 'cancel:customer:booking-rpc');
  assert.equal(calls[0].args.p_owner_operation_key, 'cancel:owner:booking-rpc');
  assert.equal(calls[0].args.p_expected_financial_snapshot.payment_status, 'authorized');
});

function payoutSupabase({ count = 0, error = null } = {}) {
  return {
    from: table => {
      assert.equal(table, 'payout_ledger');
      return {
        select: () => ({
          eq: async () => ({ count, error }),
        }),
      };
    },
  };
}

await check('all settled payout signals block cancellation payment mutation', async () => {
  const base = { id: 'booking-payout-guard' };
  const settledCases = [
    { payout_status: 'paid' },
    { payout_status: 'transferred' },
    { cancellation_easer_payout_status: 'paid' },
    { stripe_transfer_id: 'tr_settled' },
    { payout_amount: 1 },
    { paid_out_at: '2026-07-14T12:00:00.000Z' },
  ];
  for (const settled of settledCases) {
    await assert.rejects(
      assertCancellationPayoutUnsettled(payoutSupabase(), { ...base, ...settled }),
      error => error?.code === 'CANCELLATION_PAYOUT_RECONCILIATION_REQUIRED',
    );
  }
  await assert.rejects(
    assertCancellationPayoutUnsettled(payoutSupabase({ count: 1 }), base),
    error => error?.code === 'CANCELLATION_PAYOUT_RECONCILIATION_REQUIRED',
  );
  await assert.rejects(
    assertCancellationPayoutUnsettled(payoutSupabase({ error: new Error('ledger unavailable') }), base),
    error => error?.code === 'CANCELLATION_PAYOUT_TRUTH_UNAVAILABLE',
  );
  assert.equal(await assertCancellationPayoutUnsettled(payoutSupabase(), base), true);
});

await check('fee recovery requires a durable processed financial audit event', async () => {
  const calls = [];
  const query = {
    select() { return this; },
    eq(field, value) { calls.push(['eq', field, value]); return this; },
    in(field, value) { calls.push(['in', field, value]); return this; },
    async limit(value) { calls.push(['limit', value]); return { data: [{ id: 'audit-1' }], error: null }; },
  };
  const result = await hasDurableCancellationFeeCaptureAudit({ from: () => query }, {
    booking: { id: 'booking-audit' },
    paymentIntentId: 'pi_audit',
    feeCents: 1_000,
  });
  assert.equal(result, true);
  assert.ok(calls.some(call => call[1] === 'event_type' && call[2] === 'capture_attempt'));
  assert.ok(calls.some(call => call[1] === 'status' && call[2] === 'processed'));
  assert.deepEqual(calls.find(call => call[0] === 'in')[2], [
    'owner-cancel-fee-booking-audit-1000',
    'customer-cancel-fee-booking-audit-1000',
    'guest-cancel-fee-booking-audit-1000',
  ]);
});

await check('guest email authentication is exact after normalization', () => {
  const booking = { customer_email: '  Customer.Name@Example.com ' };
  assert.equal(bookingEmailMatches(booking, 'customer.name@example.com'), true);
  assert.equal(bookingEmailMatches(booking, 'customer.name+other@example.com'), false);
  assert.equal(bookingEmailMatches(booking, 'customer.name@example.co'), false);
  assert.equal(bookingEmailMatches(booking, ''), false);
  assert.equal(bookingEmailMatches({ customer_email: '' }, 'customer.name@example.com'), false);
});

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [ownerCancel, customerCancel, guestCancel, operationHelper, financialOperation, migration037] = await Promise.all([
  load('api/booking/cancel.js'),
  load('api/booking/customer-cancel.js'),
  load('api/booking/guest-cancel.js'),
  load('api/booking/_cancellation-operation.js'),
  load('api/booking/_financial-operation.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
]);

await check('in-progress or job-started bookings are blocked before any financial reservation', () => {
  for (const [name, source] of [
    ['owner', ownerCancel],
    ['customer', customerCancel],
    ['guest', guestCancel],
  ]) {
    const workGuard = source.indexOf('if (booking.status === BOOKING_STATUS.IN_PROGRESS || booking.job_started_at)');
    const payoutGuard = source.indexOf('await assertCancellationPayoutUnsettled(sb, booking)');
    const reservation = Math.min(
      ...['await reserveBookingFinancialOperation(sb', 'await claimBookingCancellationRecovery(sb']
        .map(marker => source.indexOf(marker))
        .filter(index => index >= 0),
    );
    assert.ok(workGuard >= 0, `${name} cancellation needs a work-started guard`);
    assert.ok(workGuard < payoutGuard, `${name} work-started guard must precede payout queries`);
    assert.ok(workGuard < reservation, `${name} work-started guard must precede financial reservation`);
  }
});

await check('every cancellation route requires durable financial audit truth for fee recovery', () => {
  for (const [name, source] of [
    ['owner', ownerCancel],
    ['customer', customerCancel],
    ['guest', guestCancel],
  ]) {
    assert.match(source, /await hasDurableCancellationFeeCaptureAudit\(sb, \{/, `${name} fee recovery must read durable audit truth`);
    assert.match(source, /await writeFinancialAuditRequired\(sb, \{/, `${name} Stripe mutation must persist required audit truth`);
    assert.match(source, /isUnrefundedCancellationFeeCapture\(/, `${name} fee recovery must use verified refund state`);
  }
  assert.match(ownerCancel, /eventType: 'refund_attempt'/);
  assert.match(ownerCancel, /writeFinancialAuditRequired/);
});

await check('customer ID ownership cannot fall back to email when a customer ID is bound', () => {
  assert.equal(customerOwnsBooking(
    { customer_id: 'bound-customer', customer_email: 'shared@example.com' },
    { id: 'different-customer', email: 'shared@example.com' },
  ), false);
  assert.equal(customerOwnsBooking(
    { customer_id: 'bound-customer', customer_email: 'old@example.com' },
    { id: 'bound-customer', email: 'new@example.com' },
  ), true);
  assert.equal(customerOwnsBooking(
    { customer_id: null, customer_email: ' Legacy@Example.com ' },
    { id: 'legacy-customer', email: 'legacy@example.com' },
  ), true);
  assert.match(customerCancel, /const ownsBooking = customerOwnsBooking\(booking, user\)/);
});

await check('guest route uses exact email matching before secure-token verification', () => {
  const handler = guestCancel.slice(guestCancel.indexOf('export default async function handler'));
  const emailCheck = handler.indexOf('!booking || !bookingEmailMatches(booking, email)');
  const tokenCheck = handler.indexOf('!safeTokenHashMatch(token, booking.guest_mutation_token_hash)');
  assert.ok(emailCheck >= 0 && tokenCheck > emailCheck);
});

await check('migration 037 performs owner cancellation recovery as one locked key rotation', () => {
  const start = migration037.indexOf('CREATE OR REPLACE FUNCTION public.claim_booking_cancellation_recovery');
  const end = migration037.indexOf('REVOKE ALL ON FUNCTION public.claim_booking_cancellation_recovery', start);
  assert.ok(start >= 0 && end > start);
  const rpc = migration037.slice(start, end);
  assert.match(rpc, /FOR UPDATE/);
  assert.match(rpc, /p_expected_operation_key IS DISTINCT FROM v_booking\.financial_operation_key/);
  assert.match(rpc, /financial_operation_started_at > NOW\(\) - INTERVAL '5 minutes'/);
  assert.match(rpc, /cancellation_reconciliation_required_at > NOW\(\) - INTERVAL '5 minutes'/);
  assert.match(rpc, /SET financial_operation_key = v_owner_key,[\s\S]*financial_operation_type = 'cancel_owner'/);
  assert.doesNotMatch(rpc, /financial_operation_started_at\s*=\s*NOW\(\)/, 'owner recovery must preserve the original cancellation policy time');
  assert.match(rpc, /WHERE id = v_booking\.id\s+AND financial_operation_key = p_expected_operation_key/);
  assert.match(financialOperation, /sb\.rpc\('claim_booking_cancellation_recovery'/);
  assert.match(ownerCancel, /await claimBookingCancellationRecovery\(sb, \{/);
});

await check('database cancellation locks also reject settled payout truth', () => {
  const reserveStart = migration037.indexOf('CREATE OR REPLACE FUNCTION public.reserve_booking_financial_operation');
  const reserveEnd = migration037.indexOf('REVOKE ALL ON FUNCTION public.reserve_booking_financial_operation', reserveStart);
  const reserveRpc = migration037.slice(reserveStart, reserveEnd);
  const claimStart = migration037.indexOf('CREATE OR REPLACE FUNCTION public.claim_booking_cancellation_recovery');
  const claimEnd = migration037.indexOf('REVOKE ALL ON FUNCTION public.claim_booking_cancellation_recovery', claimStart);
  const claimRpc = migration037.slice(claimStart, claimEnd);
  for (const [name, rpc] of [['reservation', reserveRpc], ['recovery', claimRpc]]) {
    assert.match(rpc, /payout_status IN \('paid', 'transferred'\)/, `${name} must block settled booking payout status`);
    assert.match(rpc, /stripe_transfer_id IS NOT NULL/, `${name} must block Stripe transfers`);
    assert.match(rpc, /EXISTS \(SELECT 1 FROM public\.payout_ledger/, `${name} must block ledger payout history`);
  }
  assert.match(operationHelper, /Number\(booking\.payout_amount \|\| 0\) > 0/);
});

if (failures.length) {
  console.error(`\nCancellation payment race checks failed: ${failures.length}`);
  for (const { name, error } of failures) console.error(`- ${name}: ${error.message}`);
  process.exitCode = 1;
} else {
  console.log('\nCancellation topology, refund settlement, payout, and owner-recovery checks passed.');
}
