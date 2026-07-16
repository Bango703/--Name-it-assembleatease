#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deriveManualPayoutReadiness } from '../api/owner/_finance-ledger.js';
import { isCurrentCompletionEvidence } from '../api/booking/_completion-evidence.js';

const baseBooking = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  assembler_id: '22222222-2222-4222-8222-222222222222',
  payment_status: 'captured',
  payout_status: 'pending',
  payout_mode_snapshot: 'manual',
  payout_review_status: 'not_required',
  damage_review_status: 'not_required',
  stripe_transfer_id: null,
  stripe_dispute_id: null,
  stripe_dispute_status: null,
  stripe_dispute_hold: false,
  financial_operation_key: null,
  financial_reconciliation_required_at: null,
  evidence_requested_at: null,
};

assert.deepEqual(
  deriveManualPayoutReadiness(baseBooking, { owed: 7113 }),
  { disposition: 'pending', holdReasons: [] },
  'a captured, manual, pending earning must be recordable',
);

const missingMode = deriveManualPayoutReadiness(
  { ...baseBooking, payout_mode_snapshot: null },
  { owed: 7113 },
);
assert.equal(missingMode.disposition, 'on_hold');
assert.match(missingMode.holdReasons.join(' '), /migration 037/i);

const wrongPayoutState = deriveManualPayoutReadiness(
  { ...baseBooking, payout_status: 'unpaid' },
  { owed: 7113 },
);
assert.equal(wrongPayoutState.disposition, 'on_hold');
assert.match(wrongPayoutState.holdReasons.join(' '), /reconciled to pending/i);

const disputeHold = deriveManualPayoutReadiness(
  {
    ...baseBooking,
    stripe_dispute_id: 'dp_test',
    stripe_dispute_status: 'needs_response',
    stripe_dispute_hold: true,
  },
  { owed: 7113 },
);
assert.equal(disputeHold.disposition, 'on_hold');
assert.match(disputeHold.holdReasons.join(' '), /unresolved customer dispute/i);

const completedRefundReview = {
  ...baseBooking,
  payment_status: 'partially_refunded',
  payout_review_status: 'approved_full',
  payout_reviewed_at: '2026-07-16T15:00:00.000Z',
  payout_reviewed_by: 'owner',
  payout_review_notes: 'Verified completed work and refund circumstances.',
};
assert.equal(
  deriveManualPayoutReadiness(completedRefundReview, { owed: 7113 }).disposition,
  'pending',
  'a fully documented refund review may release canonical Easer earnings',
);
assert.equal(
  deriveManualPayoutReadiness(
    { ...completedRefundReview, payout_review_notes: 'short' },
    { owed: 7113 },
  ).disposition,
  'on_hold',
  'an incomplete refund review record must not look payable',
);

const cancellationReady = deriveManualPayoutReadiness({
  ...baseBooking,
  status: 'cancelled',
  payment_status: 'cancellation_fee_captured',
}, { owed: 3500 });
assert.equal(cancellationReady.disposition, 'pending');

assert.equal(
  deriveManualPayoutReadiness(baseBooking, { paidOut: true, owed: 7113 }).disposition,
  'paid',
);

const evidenceBooking = {
  ...baseBooking,
  job_started_at: '2026-07-16T13:00:00.000Z',
  evidence_requested_at: '2026-07-16T14:00:00.000Z',
};
const oldEvidence = {
  evidence_type: 'completion_photo',
  uploaded_by: baseBooking.assembler_id,
  created_at: '2026-07-16T13:30:00.000Z',
};
const currentEvidence = { ...oldEvidence, created_at: '2026-07-16T14:05:00.000Z' };
assert.equal(isCurrentCompletionEvidence(oldEvidence, evidenceBooking), false);
assert.equal(isCurrentCompletionEvidence(currentEvidence, evidenceBooking), true);
assert.equal(
  deriveManualPayoutReadiness(evidenceBooking, {
    owed: 7113,
    hasCurrentCompletionEvidence: false,
  }).disposition,
  'on_hold',
);
assert.equal(
  deriveManualPayoutReadiness(evidenceBooking, {
    owed: 7113,
    hasCurrentCompletionEvidence: true,
  }).disposition,
  'pending',
);

const [ownerSource, payoutsSource] = await Promise.all([
  fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/owner/payouts.js', import.meta.url), 'utf8'),
]);
assert.match(ownerSource, /data-payout-intent="/);
assert.match(ownerSource, /intent === 'record'/);
assert.match(ownerSource, /\[data-action="payout"\]/);
assert.match(ownerSource, /This dashboard does not send funds/);
assert.match(ownerSource, /Stripe dispute payout hold:/);
assert.match(ownerSource, /data-action="stripe-dispute-review"/);
assert.match(ownerSource, /decision: 'resolve_stripe_dispute'/);
assert.match(ownerSource, /Stripe dispute hold cleared; no payout was sent/);
assert.doesNotMatch(ownerSource, /var label = job\.disposition === 'on_hold' \? 'Review ' : 'Pay '/);
assert.match(payoutsSource, /hold_reasons:\s*b\.payoutHoldReasons/);

console.log('Owner manual payout workflow tests: PASS');
