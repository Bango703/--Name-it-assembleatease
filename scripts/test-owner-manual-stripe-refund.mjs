import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createOwnerManualStripeRefunds,
  loadOwnerManualStripeRefundTruth,
} from '../api/owner/_manual-stripe-refund.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function buildStripe({
  amountCents = 14_900,
  ledgerRefundedCents = 0,
  refunds = [],
} = {}) {
  const calls = { creates: [], lists: [] };
  const charge = {
    id: 'ch_manual_1',
    payment_intent: 'pi_manual_1',
    status: 'succeeded',
    paid: true,
    captured: true,
    currency: 'usd',
    amount: amountCents,
    amount_captured: amountCents,
    amount_refunded: refunds
      .filter(refund => !['failed', 'canceled'].includes(refund.status))
      .reduce((sum, refund) => sum + refund.amount, 0),
    disputed: false,
    refunded: false,
    livemode: false,
  };
  const intent = {
    id: 'pi_manual_1',
    status: 'succeeded',
    currency: 'usd',
    amount_received: amountCents,
    livemode: false,
    metadata: {},
    latest_charge: charge,
  };
  const stripe = {
    paymentIntents: {
      retrieve: async id => {
        assert.equal(id, intent.id);
        return intent;
      },
    },
    charges: {
      retrieve: async id => {
        assert.equal(id, charge.id);
        return charge;
      },
    },
    refunds: {
      list: async params => {
        calls.lists.push(params);
        return { data: refunds, has_more: false };
      },
      create: async (params, options) => {
        calls.creates.push({ params, options });
        const refund = {
          id: `re_created_${calls.creates.length}`,
          amount: params.amount,
          status: 'succeeded',
          charge: charge.id,
          payment_intent: intent.id,
          metadata: params.metadata,
          created: 1_785_400_000 + calls.creates.length,
        };
        refunds.push(refund);
        charge.amount_refunded += params.amount;
        charge.refunded = charge.amount_refunded === charge.amount_captured;
        return refund;
      },
    },
  };
  const event = {
    id: 'payment-event-1',
    booking_id: 'booking-1',
    amount_cents: amountCents,
    refunded_cents: ledgerRefundedCents,
    payment_method: 'stripe_manual',
    stripe_payment_intent_id: intent.id,
    stripe_charge_id: charge.id,
    created_at: '2026-07-29T12:00:00.000Z',
  };
  return { stripe, calls, event };
}

const booking = {
  id: 'booking-1',
  ref: 'AAE-TESTREFUND',
  source: 'owner_manual',
  payment_status: 'offline_recorded',
};

{
  const { stripe, event } = buildStripe();
  const truth = await loadOwnerManualStripeRefundTruth({
    stripe,
    booking,
    paymentEvents: [event],
    stripeSecretKey: 'sk_test_example',
  });
  assert.equal(truth.capturedCents, 14_900);
  assert.equal(truth.ledgerRefundedCents, 0);
  assert.equal(truth.stripeRefundedCents, 0);
  assert.equal(truth.remainingRefundableCents, 14_900);
}

{
  const { stripe, calls, event } = buildStripe();
  const truth = await loadOwnerManualStripeRefundTruth({
    stripe,
    booking,
    paymentEvents: [event],
    stripeSecretKey: 'sk_test_example',
  });
  const created = await createOwnerManualStripeRefunds({
    stripe,
    booking,
    truth,
    amountCents: 2_500,
    reason: 'Customer service adjustment',
  });
  assert.equal(created.length, 1);
  assert.equal(calls.creates[0].params.payment_intent, 'pi_manual_1');
  assert.equal(calls.creates[0].params.amount, 2_500);
  assert.equal(calls.creates[0].params.metadata.bookingId, booking.id);
  assert.match(calls.creates[0].options.idempotencyKey, /owner-manual-refund-booking-1-pi_manual_1-total-2500-attempt-1/);
}

{
  const succeeded = {
    id: 're_existing',
    amount: 2_000,
    status: 'succeeded',
    charge: 'ch_manual_1',
    created: 1_785_300_000,
  };
  const pending = {
    id: 're_pending',
    amount: 1_000,
    status: 'pending',
    charge: 'ch_manual_1',
    created: 1_785_300_100,
  };
  const { stripe, event } = buildStripe({
    ledgerRefundedCents: 2_000,
    refunds: [succeeded, pending],
  });
  const truth = await loadOwnerManualStripeRefundTruth({
    stripe,
    booking,
    paymentEvents: [event],
    stripeSecretKey: 'sk_test_example',
  });
  assert.equal(truth.stripeRefundedCents, 2_000);
  assert.equal(truth.pendingRefundCents, 1_000);
  assert.equal(truth.remainingRefundableCents, 11_900);
}

{
  const { stripe, event } = buildStripe();
  event.stripe_charge_id = 'ch_wrong';
  await assert.rejects(
    () => loadOwnerManualStripeRefundTruth({
      stripe,
      booking,
      paymentEvents: [event],
      stripeSecretKey: 'sk_test_example',
    }),
    error => error.code === 'OWNER_MANUAL_STRIPE_REFUND_TRUTH_MISMATCH',
  );
}

const endpoint = read('api/owner/refund-manual-payment.js');
const helper = read('api/owner/_manual-stripe-refund.js');
const migration = read('api/migrations/045_owner_manual_stripe_refunds.sql');
const owner = read('owner/index.html');
const list = read('api/booking/list.js');
const track = read('api/booking/track.js');
const payoutTruth = read('api/owner/_manual-payment-truth.js');
const paymentRecorder = read('api/owner/record-manual-payment.js');
const payoutApi = read('api/booking/payout.js');
const assignmentApi = read('api/booking/assign.js');
const financeLedger = read('api/owner/_finance-ledger.js');

assert.match(endpoint, /if \(!verifyOwner\(req\)\)/, 'manual refund endpoint must be owner-only');
assert.match(endpoint, /booking\.source !== 'owner_manual'/, 'manual refund endpoint must require the owner-manual lane');
assert.match(endpoint, /beforeTruth\.remainingRefundableCents/, 'server Stripe truth must cap the refund amount');
assert.match(endpoint, /reserveManualRefund\(sb, booking, operationKey\)/, 'booking must be financially reserved before Stripe mutation');
assert.match(endpoint, /createOwnerManualStripeRefunds/, 'Stripe mutation must use verified payment-event truth');
assert.match(endpoint, /reconcileSucceededRefunds/, 'Stripe success must be reconciled to the durable ledger');
assert.match(endpoint, /releaseBookingFinancialOperation/, 'refund lock must be explicitly released only after reconciliation');
assert.match(endpoint, /notificationDelivered/, 'customer refund email outcome must be visible to the owner');
assert.match(endpoint, /easerPayoutAlreadySettled/, 'a settled Easer payout must remain explicitly visible after customer refund');
assert.match(endpoint, /reason\.length < 3/, 'refund reason must be required');
assert.match(endpoint, /Number\.isSafeInteger\(cents\)/, 'refund cents must be an exact safe integer');

assert.match(helper, /stripe\.refunds\.list\(\{ charge: chargeId, limit: 100 \}\)/, 'fresh Stripe refund truth must be paginated fail-closed');
assert.match(helper, /charge\.disputed === true/, 'disputed charges must not be refundable from this path');
assert.match(helper, /idempotencyKey: `owner-manual-refund-/, 'refund mutations must be idempotent');

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.owner_manual_refund_events/, 'migration must create an immutable refund ledger');
assert.match(migration, /UNIQUE \(stripe_refund_id\)/, 'each Stripe refund must be unique in the ledger');
assert.match(migration, /GRANT SELECT, INSERT ON TABLE public\.owner_manual_refund_events/, 'the refund ledger must not grant update or delete access');
assert.match(migration, /refunded_cents >= 0 AND refunded_cents <= amount_cents/, 'event refund totals must be constrained');
assert.match(migration, /financial_operation_type IS DISTINCT FROM 'refund_owner'/, 'refund RPC must require the booking financial lock');
assert.match(migration, /record_owner_manual_payment_event_v2/, 'payment event idempotency must remain available after a refund');
assert.match(migration, /v_net := v_gross - v_refunded/, 'manual balances must subtract succeeded refunds');
assert.match(migration, /amount_charged = ledger\.gross_cents/, 'migration must repair overstated completed-manual charge truth');

assert.match(owner, /data-action="refund-manual-payment"/, 'owner booking record must expose manual Stripe refunds');
assert.match(owner, /manual-refund-amount/, 'owner must enter the exact refund amount');
assert.match(owner, /manual-refund-confirm-cb/, 'owner must explicitly confirm the irreversible money action');
assert.match(owner, /Easer payout is already settled/, 'owner must be warned that customer refund does not reverse a settled Easer payout');
assert.match(owner, /\/api\/owner\/refund-manual-payment/, 'owner UI must call the verified manual refund endpoint');
assert.match(owner, /Resume \/ Reconcile Stripe Refund/, 'owner must have a safe recovery action');

assert.match(list, /amount_collected_cents = amountCollectedCents/, 'owner booking must expose net retained payments');
assert.match(list, /amount_paid_cents = paymentEvents\.length \? ledgerGrossCents/, 'owner booking must separately expose gross payments toward the invoice');
assert.match(list, /Number\(booking\.total_price \|\| 0\) - \(paymentEvents\.length \? ledgerGrossCents/, 'refunds must not create a new customer balance');
assert.match(list, /manual_stripe_refundable_cents/, 'owner UI maximum must come from server-derived ledger truth');
assert.match(track, /amountPaidTowardInvoice = \(paymentEvents \|\| \[\]\)\.length \? ledgerGross/, 'customer balance must use gross verified payments');
assert.match(track, /gross_payment_cents: grossPaymentCents/, 'customer tracking must separate gross payments from net retained');
const trackPage = read('track.html');
assert.match(trackPage, /Payment received \(gross\)/, 'customer must see gross manual payments separately');
assert.match(trackPage, /Net payments retained/, 'customer must see net retained after refunds');
assert.match(trackPage, /refund shown above does not create a new amount due/, 'customer must never be told a refund created a new balance');
assert.match(trackPage, /isOwnerManualPayment[\s\S]*Booking Total/, 'manual booking must keep the agreed booking total visible');
assert.match(payoutTruth, /hasPendingRefund/, 'pending manual Stripe refunds must block payout');
assert.match(payoutTruth, /succeededRefundedCents !== Number\(event\.refunded_cents/, 'payout must require exact Stripe/refund-ledger agreement');
assert.match(paymentRecorder, /record_owner_manual_payment_event_v4/, 'new payments must preserve gross invoice satisfaction after refunds');
assert.match(paymentRecorder, /OWNER_MANUAL_INVOICE_ALREADY_PAID/, 'the recorder must block a second customer charge after a refund');
assert.match(payoutTruth, /allowRefundedOriginalPayment/, 'refund-affected payment truth must be explicitly opted into');
assert.match(payoutApi, /ownerManualRefundAffected/, 'manual refunds must enter the explicit Easer earnings review lane');
assert.match(assignmentApi, /payout_review_status: Number\(booking\.refund_amount \|\| 0\) > 0 \? 'review_required'/, 'historical owner-Easer attribution after a refund must open review');
assert.match(financeLedger, /Refund-affected Easer earnings require a completed owner review/, 'canonical payout finance must retain the refund review hold');

console.log('Owner manual Stripe refund safety checks passed.');
