#!/usr/bin/env node
// The owner's way out of an unconfirmed hold, and the panel that describes it.
//
// On 2026-09-19 booking AAE-DVSNHXE4OO held a saved Visa and a PaymentIntent
// stuck at requires_confirmation. The dashboard called that "No payment
// authorization or charge is confirmed" under a red "Confirmed/payment
// mismatch: do not dispatch" banner, and offered exactly one button: email the
// customer a secure link to re-confirm a card that was never the problem.
// reconcile-payment-authorization refuses that state by design, because Stripe
// is not holding anything yet.
//
// So: an action that finishes the hold, a panel that says what is true, and a
// money panel that stops claiming a platform fee on a job that has collected
// nothing.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeRetryBlock } from '../api/owner/retry-authorization.js';

const stuck = {
  id: 'b-1',
  ref: 'AAE-DVSNHXE4OO',
  status: 'confirmed',
  payment_status: 'pending',
  dispatch_status: 'payment_hold',
  stripe_payment_intent_id: 'pi_live',
  stripe_payment_method_id: 'pm_live',
  financial_operation_key: null,
  assembler_id: 'easer-1',
};

// ── 1. The state this exists for is allowed through ─────────────────────────
assert.equal(describeRetryBlock(stuck), null, 'a created-but-unconfirmed hold can be retried');

// ── 2. Everything else is refused, and says why ─────────────────────────────
const refusals = [
  [null, 'BOOKING_NOT_FOUND', 404],
  [{ ...stuck, status: 'cancelled' }, 'BOOKING_NOT_CONFIRMED', 409],
  [{ ...stuck, payment_status: 'authorized' }, 'ALREADY_AUTHORIZED', 409],
  [{ ...stuck, payment_status: 'card_saved' }, 'PAYMENT_STATE_NOT_RETRYABLE', 409],
  [{ ...stuck, payment_status: 'captured' }, 'PAYMENT_STATE_NOT_RETRYABLE', 409],
  [{ ...stuck, stripe_payment_intent_id: null }, 'NO_HOLD_TO_FINISH', 409],
  [{ ...stuck, stripe_payment_method_id: null }, 'NO_SAVED_CARD', 409],
  [{ ...stuck, financial_operation_key: 'scheduled-auth:b-1:2026-09-24' }, 'OPERATION_IN_FLIGHT', 409],
];
for (const [booking, code, status] of refusals) {
  const block = describeRetryBlock(booking);
  assert.ok(block, `${code} must be refused`);
  assert.equal(block.code, code);
  assert.equal(block.status, status);
  assert.ok(block.message && block.message.trim().length > 10, `${code} must explain itself to the owner`);
}

// ── 3. The endpoint proves the owner, and reuses the cron's own code ─────────
const endpoint = await readFile(new URL('../api/owner/retry-authorization.js', import.meta.url), 'utf8');
assert.match(endpoint, /if \(!verifyOwner\(req\)\) return res\.status\(401\)/, 'owner-only');
assert.match(endpoint, /finishUnconfirmedHold/, 'it runs the same path the nightly job runs');
assert.doesNotMatch(endpoint, /paymentIntents\.(confirm|create|capture)\(/,
  'it must not hand-roll its own Stripe money call');
assert.match(endpoint, /CUSTOMER_ACTION_REQUIRED/, 'a real bank request is reported as one');

// ── 4. The dashboard tells the truth about this state ───────────────────────
const dashboard = await readFile(new URL('../owner/index.html', import.meta.url), 'utf8');
assert.match(dashboard, /Card saved; the hold has not completed yet and retries automatically/,
  'the payment line says the card is saved and the hold is pending');
assert.match(dashboard, /data-action="retry-authorization"/, 'the owner is offered the action that finishes it');
assert.match(dashboard, /'\/api\/owner\/retry-authorization'/, 'wired to the endpoint');
assert.match(dashboard, /'retry-authorization': 'Finish the card hold/, 'the recommended-action copy explains it');

// The red "do not dispatch" banner still exists for genuine mismatches, but the
// unconfirmed-hold case must be handled before it.
const holdBranch = dashboard.indexOf("b.payment_status === 'pending' && b.dispatch_status === 'payment_hold'");
const mismatchBanner = dashboard.indexOf('Confirmed/payment mismatch:');
assert.ok(holdBranch > 0 && mismatchBanner > 0, 'both branches exist');
assert.ok(holdBranch < mismatchBanner, 'the unconfirmed-hold case is handled before the generic mismatch banner');

// ── 5. No platform fee on a job that has collected nothing ──────────────────
const feeBlock = dashboard.slice(dashboard.indexOf("field('Platform Fee'"), dashboard.indexOf("field('Easer Earnings'"));
assert.match(feeBlock, /b\.assembler_due == null/,
  'the fee is gated on finalized Easer earnings, exactly like Platform Gross');
assert.match(feeBlock, /Not finalized — set when the job completes/);
const grossBlock = dashboard.slice(dashboard.indexOf("field('Platform Gross'"), dashboard.indexOf("field('Status'"));
assert.match(grossBlock, /b\.assembler_due == null/, 'Platform Gross keeps its existing guard');

console.log('Owner retry-authorization and payment panel tests: PASS');
