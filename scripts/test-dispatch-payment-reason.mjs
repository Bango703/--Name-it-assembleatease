import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  describeDispatchPaymentBlock,
  describeStaffingPaymentBlock,
  isBookingPaymentReadyForDispatch,
  isBookingPaymentReadyForStaffing,
  DISPATCH_PAYMENT_STATUSES,
  STAFFING_PAYMENT_STATUSES,
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
  assert.match(src, /describe(Dispatch|Staffing)PaymentBlock/, `${rel} must use the explaining gate`);
  assert.doesNotMatch(src, /'Payment is not verified for (assignment|dispatch)\./,
    `${rel} must not hard-code the generic refusal`);
  assert.doesNotMatch(src, /code: 'DISPATCH_PAYMENT_NOT_VERIFIED',\s*\}\);/,
    `${rel} must return the specific code, not the catch-all`);
}

// ── Scheduled bookings: a SAVED card is not a MISSING card ─────────────────
// A booking taken more than a week out defers its hold to 5 days before the
// visit. Treating that as unpayable meant no advance booking could be staffed
// until the last minute, while the customer had already been told a pro had
// reserved the time.
const saved = { total_price: 25000, payment_status: 'card_saved', stripe_payment_method_id: 'pm_1' };

// Staffing (offers, owner assignment, acceptance): allowed for a saved card
// (owner, 2026-10-16: an advance Austin booking sent no offers).
assert.equal(describeStaffingPaymentBlock(saved), null, 'a confirmed saved card can be staffed');
assert.equal(isBookingPaymentReadyForStaffing(saved), true);
assert.ok(STAFFING_PAYMENT_STATUSES.includes('card_saved'));

// Starting work still waits for the hold, and says so.
const workBlock = describeDispatchPaymentBlock(saved);
assert.ok(workBlock, 'work waits for the scheduled hold');
assert.equal(workBlock.code, 'CARD_SAVED_AWAITING_AUTHORIZATION');
assert.match(workBlock.message, /can be staffed now; work starts after the hold/);
assert.equal(isBookingPaymentReadyForDispatch(saved), false);
assert.equal(DISPATCH_PAYMENT_STATUSES.includes('card_saved'), false,
  'travel, arrival and capture still need an authorized card');

// A card_saved booking with no saved payment method is still refused, even for
// the owner — there would be nothing to authorize before the visit.
const savedNoMethod = { total_price: 25000, payment_status: 'card_saved' };
const noMethod = describeDispatchPaymentBlock(savedNoMethod, { allowSavedCard: true });
assert.ok(noMethod);
assert.equal(noMethod.code, 'SAVED_CARD_MISSING');

// allowSavedCard must not weaken anything else.
assert.ok(describeDispatchPaymentBlock({ ...saved, payment_status: 'pending' }, { allowSavedCard: true }),
  'allowSavedCard must never make an unpaid booking assignable');
assert.ok(describeDispatchPaymentBlock({ ...saved, stripe_dispute_id: 'dp_1', stripe_dispute_status: 'lost' }, { allowSavedCard: true }),
  'allowSavedCard must never bypass a dispute');
assert.ok(describeDispatchPaymentBlock({ ...saved, financial_operation_type: 'refund_owner' }, { allowSavedCard: true }),
  'allowSavedCard must never bypass an in-flight financial operation');

// ── Every staffing path uses the staffing rule ─────────────────────────────
for (const rel of ['api/booking/assign.js', 'api/booking/dispatch.js', 'api/booking/dispatch-control.js', 'api/booking/_dispatch-internal.js', 'api/cron/auto-dispatch.js', 'api/booking/accept-dispatch.js', 'api/owner/dispatch-all.js']) {
  const src = await read(rel);
  assert.match(src, /(describe|isBookingPaymentReadyFor)Staffing|STAFFING_PAYMENT_STATUSES/, `${rel} staffs a saved card`);
  assert.doesNotMatch(src, /allowSavedCard/, `${rel} uses the named staffing rule, not the raw option`);
}
// Work paths stay strict.
assert.match(await read('api/booking/easer-status.js'), /isBookingPaymentReadyForDispatch\(booking\)/,
  'travel and arrival still require an authorized card');

// ── Money is still gated where money actually moves ────────────────────────
const completeSrc = await read('api/booking/assembler-complete.js');
assert.match(completeSrc, /\['authorized', 'deposit_paid', 'captured'\]\.includes\(booking\.payment_status\)/,
  'a saved-card job may be STAFFED but never completed or captured');

// ── A failed hold must reach the pro who blocked out the day ───────────────
const cronSrc = await read('api/cron/authorize-scheduled-payments.js');
assert.match(cronSrc, /notifyAssignedEaserPaymentHold/,
  'a failed scheduled authorization must tell the assigned Easer, not only the owner');
assert.match(cronSrc, /Do not travel to this job until it is confirmed/);

console.log('PASS dispatch payment reason: specific refusals, saved cards staffed, work waits for the hold');
