import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateEaserAppointmentGate } from '../api/booking/_appointment-gates.js';
import { isCurrentCompletionEvidence } from '../api/booking/_completion-evidence.js';
import { captureOrRecoverBookingPayment } from '../api/booking/_stripe-booking-payment.js';
import { summarizeFinanceRows } from '../api/owner/_finance-ledger.js';

const appointmentMs = Date.parse('2026-07-13T12:00:00.000Z');
const tooEarly = evaluateEaserAppointmentGate({
  date: '2026-07-13',
  time: '7:00 AM – 9:00 AM',
  stage: 'completed',
  nowMs: appointmentMs - 31 * 60_000,
});
assert.equal(tooEarly.allowed, false, 'completion must be blocked outside its Austin appointment window');
assert.equal(tooEarly.code, 'APPOINTMENT_STAGE_TOO_EARLY');
assert.equal(evaluateEaserAppointmentGate({
  date: '2026-07-13',
  time: '7:00 AM – 9:00 AM',
  stage: 'completed',
  nowMs: appointmentMs - 30 * 60_000,
}).allowed, true, 'completion may open at the configured early boundary');
assert.equal(evaluateEaserAppointmentGate({ date: 'bad', time: 'bad', stage: 'completed' }).allowed, false);

const bookingEvidenceTruth = {
  assembler_id: 'easer-current',
  job_started_at: '2026-07-13T12:30:00.000Z',
};
assert.equal(isCurrentCompletionEvidence({
  evidence_type: 'completion_photo',
  uploaded_by: 'easer-current',
  created_at: '2026-07-13T12:30:00.000Z',
}, bookingEvidenceTruth), true);
assert.equal(isCurrentCompletionEvidence({
  evidence_type: 'damage_claim',
  uploaded_by: 'easer-current',
  created_at: '2026-07-13T12:31:00.000Z',
}, bookingEvidenceTruth), false, 'unrelated evidence must never satisfy completion');
assert.equal(isCurrentCompletionEvidence({
  evidence_type: 'completion_photo',
  uploaded_by: 'easer-previous',
  created_at: '2026-07-13T12:31:00.000Z',
}, bookingEvidenceTruth), false, 'a previous Easer photo must never satisfy completion');
assert.equal(isCurrentCompletionEvidence({
  evidence_type: 'completion_photo',
  uploaded_by: 'easer-current',
  created_at: '2026-07-13T12:29:59.000Z',
}, bookingEvidenceTruth), false, 'pre-work evidence must never satisfy completion');

const auditRows = [];
const fakeSb = {
  from: () => ({
    insert: async row => {
      auditRows.push(row);
      return { error: null };
    },
  }),
};
const depositBooking = {
  id: 'booking-deposit',
  ref: 'AAE-DEPOSIT',
  service: 'Furniture assembly',
  customer_name: 'Customer',
  total_price: 10_000,
  deposit_amount: 2_500,
  is_deposit: true,
  payment_status: 'deposit_paid',
  stripe_deposit_intent_id: 'pi_deposit',
  stripe_customer_id: 'cus_1',
  stripe_payment_method_id: 'pm_1',
};
const stripeCalls = [];
const fakeStripe = {
  paymentIntents: {
    list: async params => {
      assert.equal(params.customer, 'cus_1');
      return { data: [] };
    },
    retrieve: async id => {
      assert.equal(id, 'pi_deposit');
      return {
        id,
        status: 'succeeded',
        currency: 'usd',
        amount_received: 2_500,
        metadata: { bookingId: depositBooking.id, type: 'customer_booking' },
        latest_charge: { balance_transaction: { fee: 103 } },
      };
    },
    create: async (params, options) => {
      stripeCalls.push({ params, options });
      return {
        id: 'pi_balance',
        status: 'succeeded',
        currency: 'usd',
        amount_received: params.amount,
        metadata: params.metadata,
        latest_charge: { balance_transaction: { fee: 248 } },
      };
    },
  },
};
const depositResult = await captureOrRecoverBookingPayment({
  stripe: fakeStripe,
  sb: fakeSb,
  booking: depositBooking,
  eventSource: 'checkpoint_test',
});
assert.deepEqual(depositResult, {
  amountCharged: 10_000,
  actualStripeFee: 351,
  balancePaymentIntentId: 'pi_balance',
  balanceAmountCaptured: 7_500,
});
assert.equal(stripeCalls[0].params.amount, 7_500);
assert.equal(stripeCalls[0].params.metadata.type, 'customer_booking_balance');
assert.equal(stripeCalls[0].options.idempotencyKey, 'booking-complete-balance-booking-deposit');
assert.ok(auditRows.some(row => row.idempotency_key === 'booking-complete-balance-booking-deposit'));

const financeSummary = summarizeFinanceRows([
  {
    status: 'completed', netCharged: 10_000, taxCollected: 700, stripeFee: 320,
    stripeFeeIsActual: true, paidOut: false, payoutDisposition: 'pending', owed: 6_000, platformRevenue: 2_980,
  },
  {
    status: 'cancelled', cancellationEarnings: true, netCharged: 5_000, taxCollected: 0,
    stripeFee: 175, stripeFeeIsActual: true, paidOut: false, payoutDisposition: 'pending', owed: 3_500, platformRevenue: 1_325,
  },
]);
assert.equal(financeSummary.completedJobs, 1, 'cancellation earnings must not inflate completed-job count');
assert.equal(financeSummary.cancellationEarningEvents, 1);
assert.equal(financeSummary.pendingPayouts, 9_500, 'owner reserves must include both earning types');

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  ownerComplete,
  easerComplete,
  ownerCancel,
  customerCancel,
  guestCancel,
  payout,
  payoutCron,
  webhook,
  rejection,
  assignments,
  easerPayoutPage,
  financeLedger,
  ownerPayouts,
  migration,
  readiness,
  staleBooking,
  reschedule,
  operationHelper,
  stripeHelper,
  cancellationStripeHelper,
] = await Promise.all([
  load('api/booking/complete.js'),
  load('api/booking/assembler-complete.js'),
  load('api/booking/cancel.js'),
  load('api/booking/customer-cancel.js'),
  load('api/booking/guest-cancel.js'),
  load('api/booking/payout.js'),
  load('api/cron/release-payouts.js'),
  load('api/assembler/stripe-webhook.js'),
  load('api/assembler/update.js'),
  load('api/booking/my-assignments.js'),
  load('assembler/payouts.html'),
  load('api/owner/_finance-ledger.js'),
  load('api/owner/payouts.js'),
  load('api/migrations/035_financial_completion_reservations.sql'),
  load('api/owner/live-readiness-check.js'),
  load('api/cron/stale-booking.js'),
  load('api/booking/reschedule.js'),
  load('api/booking/_financial-operation.js'),
  load('api/booking/_stripe-booking-payment.js'),
  load('api/booking/_cancellation-stripe-truth.js'),
]);

for (const source of [ownerComplete, easerComplete]) {
  assert.match(source, /evaluateEaserAppointmentGate/);
  assert.match(source, /loadCurrentCompletionEvidence/);
  assert.match(source, /resolveOrCreateEaserFeeSnapshot/);
  assert.match(source, /reserveBookingFinancialOperation/);
  assert.match(source, /expectedStatuses:\s*\[BOOKING_STATUS\.IN_PROGRESS\]/);
  assert.match(source, /\.eq\('financial_operation_key', operationKey\)/);
  assert.match(source, /stripe_balance_payment_intent_id/);
  assert.match(source, /const operationKey = `complete:\$\{booking\.id\}`/);
}
for (const source of [ownerCancel, customerCancel, guestCancel]) {
  assert.match(source, /reserveBookingFinancialOperation/);
  assert.match(source, /\.eq\('financial_operation_key', operationKey\)/);
  assert.match(source, /cancellation_easer_due_cents/);
}
assert.match(ownerCancel, /bookingCancellationPaymentIntentIds\(booking\)/);
assert.match(ownerCancel, /loadBookingCancellationPaymentIntents\(stripe, booking\)/);
assert.match(cancellationStripeHelper, /stripe_balance_payment_intent_id/);
assert.match(ownerCancel, /keyPrefix: 'owner-cancel-refund'/);
assert.match(ownerCancel, /\$\{keyPrefix\}-\$\{booking\.id\}-\$\{row\.paymentIntentId\}/);
assert.match(ownerCancel, /stripe\.refunds\.list/);
assert.match(webhook, /customer_booking_balance/);
assert.match(webhook, /stripe_balance_amount_captured/);
assert.match(payout, /booking\.payout_mode_snapshot !== 'manual'/);
assert.match(payout, /PAYOUT_MODE_RECONCILIATION_REQUIRED/);
assert.doesNotMatch(payout, /isStripeConnectEnabled/, 'historical manual liabilities must not be rerouted by the current Connect flag');
assert.match(payout, /loadCurrentCompletionEvidence/);
assert.match(payoutCron, /payout:connect:/);
assert.match(payoutCron, /cancellation_easer_due_cents/);
assert.match(rejection, /easer-application-rejection-refund-\$\{assemblerId\}/);
// Rejection refund truth (retrieve + list + pagination) is loaded through the
// centralized helper; the aggregate must reach the exact canonical fee with a
// confirmed refund id + timestamp before the application is marked refunded.
assert.match(rejection, /loadEaserApplicationFeeRefundTruth/);
assert.match(rejection, /validateEaserApplicationPaymentIntent/);
assert.match(rejection, /refundedCents !== EASER_APPLICATION_FEE_CENTS \|\| !refundId \|\| !refundedAt/);
assert.match(rejection, /Stripe could not safely cancel or refund the application payment\. The application was not rejected/);
assert.match(assignments, /cancellation_easer_due_cents/);
assert.match(assignments, /easer_fee_pct_snapshot/);
assert.match(assignments, /\.eq\('evidence_type', 'completion_photo'\)/);
assert.match(easerPayoutPage, /Cancellation trip earnings/);
assert.match(financeLedger, /cancellationEarningRows/);
assert.match(ownerPayouts, /cancellation_earnings/);
assert.match(migration, /Migration 035/);
assert.match(migration, /reserve_booking_financial_operation/);
assert.match(migration, /financial_operation_key/);
assert.match(migration, /p_check_assembler_id/);
assert.match(migration, /p_expected_financial_snapshot/);
assert.match(migration, /completion_owner', 'completion_easer/);
assert.match(migration, /evidence\.evidence_type = 'completion_photo'/);
assert.match(migration, /VALUES \(35, 'financial_completion_reservations'\)/);
assert.match(readiness, /REQUIRED_SCHEMA_MIGRATION\s*=\s*41/);
assert.match(readiness, /DATABASE_SCHEMA_041/);
assert.match(readiness, /Apply migrations 038-041 in order/);
assert.doesNotMatch(readiness, /DATABASE_SCHEMA_036|Apply migrations 034-036/);
assert.match(operationHelper, /p_check_assembler_id: true/);
assert.match(operationHelper, /p_expected_financial_snapshot/);
assert.match(stripeHelper, /paymentIntents\.list/);
assert.match(stripeHelper, /DUPLICATE_BALANCE_PAYMENT_REVIEW_REQUIRED/);
assert.match(reschedule, /\.is\('financial_operation_key', null\)/);
assert.match(staleBooking, /easer_fee_snapshot_easer_id: null/);
assert.match(staleBooking, /assignment_token: null/);
assert.match(staleBooking, /status: 'confirmed'/);
assert.match(staleBooking, /needs_manual_dispatch: true/);
assert.match(staleBooking, /dispatch_paused: true/);
assert.match(staleBooking, /requeueQuery\.eq\('assignment_token', b\.assignment_token\)/);
assert.match(staleBooking, /eventType: 'dispatch_manual_required'/);
assert.match(staleBooking, /Unaccepted booking lookup failed/);
assert.match(staleBooking, /\.is\('financial_operation_key', null\)/);
assert.ok(
  staleBooking.indexOf("requeueQuery.select('id')") < staleBooking.indexOf('// Notify owner to reassign'),
  'auto-requeue notifications must happen only after the exact CAS succeeds',
);
assert.ok(
  staleBooking.indexOf(".select('id');", staleBooking.indexOf('declinedRows')) < staleBooking.indexOf('// Notify customer', staleBooking.indexOf('declinedRows')),
  'stale-decline notifications must happen only after the exact CAS succeeds',
);

console.log('checkpoint3 financial truth tests: PASS');
