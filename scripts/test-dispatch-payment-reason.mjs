import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  describeDispatchPaymentBlock,
  isBookingPaymentReadyForDispatch,
} from '../api/_source-of-truth.js';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const ready = extra => ({ total_price: 25000, payment_status: 'authorized', stripe_payment_intent_id: 'pi_1', ...extra });

// ── A ready booking is ready, and says nothing ─────────────────────────────
assert.equal(describeDispatchPaymentBlock(ready()), null);
assert.equal(isBookingPaymentReadyForDispatch(ready()), true);

// ── Every refusal names a cause, and never a generic one ───────────────────
const cases = [
  ['CUSTOMER_PAYMENT_NOT_AUTHORIZED', ready({ payment_status: 'pending' }), /card is "pending", not authorized/],
  ['CUSTOMER_PAYMENT_NOT_AUTHORIZED', ready({ payment_status: '' }),        /card is "missing", not authorized/],
  ['CUSTOMER_PAYMENT_NOT_AUTHORIZED', ready({ payment_status: 'captured' }), /not authorized/],
  ['PAYMENT_INTENT_MISSING',    ready({ stripe_payment_intent_id: null }),   /no Stripe PaymentIntent/],
  ['PAYMENT_OPERATION_IN_PROGRESS', ready({ financial_operation_type: 'refund_owner' }), /refund owner is already running/],
  ['FINANCIAL_RECONCILIATION_REQUIRED', ready({ financial_reconciliation_required_at: '2026-01-01' }), /reconciling against Stripe/],
  ['CANCELLATION_RECONCILIATION_REQUIRED', ready({ cancellation_reconciliation_required_at: '2026-01-01' }), /cancellation needs reconciling/],
  ['PAYMENT_DISPUTED',          ready({ stripe_dispute_id: 'dp_1', stripe_dispute_status: 'needs_response' }), /disputed this charge/],
  ['BOOKING_TOTAL_INVALID',     ready({ total_price: 0 }),                   /\$0 total/],
  ['DEPOSIT_AMOUNT_INVALID',    ready({ payment_status: 'deposit_paid', deposit_amount: 0 }), /deposit amount is missing/],
  ['DEPOSIT_INTENT_MISSING',    { total_price: 25000, payment_status: 'deposit_paid', deposit_amount: 5000 }, /no Stripe intent/],
];
for (const [code, booking, pattern] of cases) {
  const block = describeDispatchPaymentBlock(booking, { vercelEnv: 'production' });
  assert.ok(block, `${code}: expected a refusal`);
  assert.equal(block.code, code);
  assert.match(block.message, pattern);
  assert.equal(isBookingPaymentReadyForDispatch(booking, { vercelEnv: 'production' }), false,
    `${code}: the explanation and the gate must agree`);
  assert.doesNotMatch(block.message, /^Payment is not verified/,
    `${code}: the generic message is what sent an owner hunting the wrong thing`);
}

// ── The specific confusion this fixes ──────────────────────────────────────
// An owner assigning a payout-ready pro read "Payment is not verified" as the
// PRO's payment setup. The message must say whose payment it means.
const unpaid = describeDispatchPaymentBlock(ready({ payment_status: 'pending' }));
assert.match(unpaid.message, /customer's payment, not the Easer's payout setup/,
  'the refusal must distinguish the customer payment from the Easer payout setup');

// ── The zero-dollar simulation escape hatch is preserved ───────────────────
const sim = { total_price: 0, confirmed_by: 'owner_zero_dollar_simulation' };
assert.equal(describeDispatchPaymentBlock(sim, { vercelEnv: 'preview' }), null);
assert.ok(describeDispatchPaymentBlock(sim, { vercelEnv: 'production' }), 'never in production');

// ── The callers actually surface the reason (Article 16) ───────────────────
for (const rel of ['api/booking/assign.js', 'api/booking/dispatch.js', 'api/booking/dispatch-control.js']) {
  const src = await read(rel);
  assert.match(src, /describeDispatchPaymentBlock/, `${rel} must use the explaining gate`);
  assert.doesNotMatch(src, /'Payment is not verified for (assignment|dispatch)\./,
    `${rel} must not hard-code the generic refusal`);
  assert.doesNotMatch(src, /code: 'DISPATCH_PAYMENT_NOT_VERIFIED',\s*\}\);/,
    `${rel} must return the specific code, not the catch-all`);
}

console.log('dispatch payment reason tests: PASS');
