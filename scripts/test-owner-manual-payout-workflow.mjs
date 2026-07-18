#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  deriveManualPayoutReadiness,
  hasVerifiedOfflineOwnerPayment,
} from '../api/owner/_finance-ledger.js';
import { isCurrentCompletionEvidence } from '../api/booking/_completion-evidence.js';
import { normalizeOwnerOfflinePaymentMethod } from '../api/owner/_offline-payment.js';

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
  { disposition: 'pending', holdReasons: [], holdCodes: [] },
  'a captured, manual, pending earning must be recordable',
);

const verifiedOfflineOwnerBooking = {
  ...baseBooking,
  source: 'owner_manual',
  payment_status: 'offline_recorded',
  payment_collected: true,
  payment_collected_at: '2026-07-17T14:00:00.000Z',
  payment_collected_by: 'owner',
  payment_method: 'card_on_site',
  amount_charged: 11000,
};
assert.equal(hasVerifiedOfflineOwnerPayment(verifiedOfflineOwnerBooking), true);
assert.equal(normalizeOwnerOfflinePaymentMethod(' CARD_ON_SITE '), 'card_on_site');
assert.equal(normalizeOwnerOfflinePaymentMethod('browser_supplied_value'), null);
assert.equal(
  deriveManualPayoutReadiness(verifiedOfflineOwnerBooking, { owed: 7113 }).disposition,
  'pending',
  'audited owner-manual customer collection must release the canonical manual payout lane',
);

for (const unsafeOfflineBooking of [
  { ...verifiedOfflineOwnerBooking, payment_collected: false, payment_collected_at: null, payment_collected_by: null },
  { ...verifiedOfflineOwnerBooking, payment_collected_at: null },
  { ...verifiedOfflineOwnerBooking, payment_collected_by: null },
  { ...verifiedOfflineOwnerBooking, payment_method: null },
  { ...verifiedOfflineOwnerBooking, amount_charged: 0, total_price: 0 },
  { ...verifiedOfflineOwnerBooking, source: 'online' },
]) {
  assert.equal(hasVerifiedOfflineOwnerPayment(unsafeOfflineBooking), false);
  const unsafeResult = deriveManualPayoutReadiness(unsafeOfflineBooking, { owed: 7113 });
  assert.equal(unsafeResult.disposition, 'on_hold');
}

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

const [ownerSource, payoutsSource, payoutApiSource, collectionApiSource, migrationSource, visualAuditSource] = await Promise.all([
  fs.readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/owner/payouts.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/booking/payout.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/owner/mark-payment-collected.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../api/migrations/041_owner_manual_collected_payout.sql', import.meta.url), 'utf8'),
  fs.readFile(new URL('./mobile-visual-audit.mjs', import.meta.url), 'utf8'),
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
assert.match(ownerSource, /Step 1 complete:/);
assert.match(ownerSource, /Step 2 verified:/);
assert.match(ownerSource, /Record External Easer Payout/);
assert.match(ownerSource, /Confirm Offline Customer Payment/);
assert.match(ownerSource, /collection-confirm-cb/);
assert.match(ownerSource, /confirmedAmountCents/);
assert.match(ownerSource, /payoutJobsByBookingId/);
assert.match(ownerSource, /canonicalPayoutJob\.disposition === 'pending'/);
assert.match(ownerSource, /Number\.isInteger\(canonicalPayoutCents\)/);
assert.match(ownerSource, /Number\.isInteger\(assemblerDueCents\)/);
assert.match(ownerSource, /offlineCustomerTotalCents = Number\(b\.amount_charged \?\? b\.total_price \?\? 0\)/);
assert.doesNotMatch(ownerSource, /currentPayoutTruth\.owed \|\|[\s\S]{0,160}assembler_due/);
assert.doesNotMatch(ownerSource, /var offlineDamageReady|var offlineDisputeOpen/);
assert.match(ownerSource, /loadPayoutLedger\(\);[\s\S]*Nav badge: pending Easer applications/);
assert.match(payoutApiSource, /hasVerifiedOfflineOwnerPayment\(booking\)/);
assert.match(payoutApiSource, /deriveManualPayoutReadiness\(booking/);
assert.match(collectionApiSource, /normalizeOwnerOfflinePaymentMethod\(paymentMethod\)/);
assert.match(collectionApiSource, /confirmedCents !== canonicalAmountCents/);
assert.match(collectionApiSource, /booking\.payment_status !== 'offline_recorded'/);
assert.match(collectionApiSource, /existingMethod !== normalizedMethod/);
assert.match(visualAuditSource, /owner-manual-uncollected/);
assert.match(visualAuditSource, /ownerOfflineCollection/);
assert.match(visualAuditSource, /\/api\/owner\/mark-payment-collected/);
assert.match(visualAuditSource, /requestCountAfterAcknowledgementBlock === requestCountBeforeAcknowledgement/);
assert.match(migrationSource, /booking_row\.source = 'owner_manual'/);
assert.match(migrationSource, /booking_row\.payment_status = 'offline_recorded'/);
assert.match(migrationSource, /booking_row\.payment_collected IS TRUE/);
assert.match(migrationSource, /booking_row\.payment_collected_at IS NOT NULL/);
assert.match(migrationSource, /BTRIM\(booking_row\.payment_collected_by\)/);
assert.match(migrationSource, /BTRIM\(booking_row\.payment_method\)/);
assert.match(migrationSource, /COALESCE\(booking_row\.amount_charged, booking_row\.total_price, 0\) > 0/);
assert.match(migrationSource, /booking_row\.payment_status = 'captured'/);
assert.match(migrationSource, /Payout state must be pending/);

console.log('Owner manual payout workflow tests: PASS');
