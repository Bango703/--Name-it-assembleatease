import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCurrentCompletionEvidence } from '../api/booking/_completion-evidence.js';
import { deriveManualPayoutReadiness } from '../api/owner/_finance-ledger.js';

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const [
  ownerUi,
  liveOps,
  monitor,
  taxReport,
  paymentList,
  paymentRecorder,
  trackApi,
  trackUi,
  payoutApi,
  refundApi,
  reviewsApi,
  notesApi,
  jobsApi,
  testPushApi,
  testEaserApi,
  ownerAuth,
] = await Promise.all([
  read('owner/index.html'),
  read('api/owner/live-ops.js'),
  read('api/owner/monitor.js'),
  read('api/owner/tax-report.js'),
  read('api/booking/list.js'),
  read('api/owner/record-manual-payment.js'),
  read('api/booking/track.js'),
  read('track.html'),
  read('api/booking/payout.js'),
  read('api/booking/refund.js'),
  read('api/owner/reviews.js'),
  read('api/booking/notes.js'),
  read('api/owner/jobs.js'),
  read('api/owner/test-push.js'),
  read('api/owner/create-test-easer.js'),
  read('api/_email.js'),
]);

assert.match(ownerAuth, /Production accepts signed bearer sessions only/);
assert.match(ownerAuth, /const allowLegacyPassword = process\.env\.VERCEL_ENV !== 'production'/);
assert.match(ownerUi, /Authorization': 'Bearer ' \+ ownerSessionToken/);
assert.match(ownerUi, /replace\(\/"\/g, '&quot;'\)/);
assert.match(ownerUi, /replace\(\/'\/g, '&#39;'\)/);
assert.match(ownerUi, /\.modal-row\{grid-template-columns:minmax\(0,1fr\)\}/);
assert.match(ownerUi, /max-height:calc\(100dvh - 1rem\)/);
assert.match(ownerUi, /Selected-Period Money Summary/);
assert.match(ownerUi, /an-sales-tax/);
assert.match(ownerUi, /an-processing-fees/);
assert.match(ownerUi, /an-easer-payouts/);
assert.match(ownerUi, /Platform Gross After Tax, Stripe &amp; Easer/);
assert.match(ownerUi, /Central time/);
assert.match(ownerUi, /No completed jobs in/);
assert.match(ownerUi, /Show All Time/);
assert.match(ownerUi, /async function loadBookings\(forceRefresh\)/);
assert.match(ownerUi, /if \(_bookingsLoadPromise\) \{\s*await _bookingsLoadPromise;\s*if \(!forceRefresh\) return;/);
assert.doesNotMatch(ownerUi, /_bookingsLoading/);
assert.ok(
  [...ownerUi.matchAll(/await loadBookings\(true\);/g)].length >= 3,
  'Owner financial and case mutations must force a fresh booking read before re-rendering.',
);
const damageReviewMutation = ownerUi.slice(
  ownerUi.indexOf("pendingAction.type === 'damage-review'"),
  ownerUi.indexOf("pendingAction.type === 'payout-review'"),
);
const payoutReviewMutation = ownerUi.slice(
  ownerUi.indexOf("pendingAction.type === 'payout-review'"),
  ownerUi.indexOf("pendingAction.type === 'refund'"),
);
for (const mutation of [damageReviewMutation, payoutReviewMutation]) {
  assert.match(mutation, /await loadBookings\(true\);\s*await loadPayoutLedger\(\);\s*if \(selectedId\) selectBooking\(selectedId\);/);
}
assert.doesNotMatch(ownerUi, /id="test-push-btn"/);
assert.doesNotMatch(ownerUi, /deleteReview\(/);

for (const source of [testPushApi, testEaserApi]) {
  assert.match(source, /process\.env\.VERCEL_ENV === 'production' \|\|/);
  assert.match(source, /ENABLE_TEST_ENDPOINTS/);
}
assert.match(reviewsApi, /Reviews must be hidden, not permanently deleted/);
assert.match(notesApi, /author: 'Owner'/);
assert.match(notesApi, /Note must be 5,000 characters or fewer/);
assert.match(jobsApi, /Marketplace jobs must be closed, not permanently deleted/);

assert.match(liveOps, /ownerManualReconciliation/);
assert.match(liveOps, /source\.eq\.owner_manual/);
assert.match(liveOps, /return_visit_completed_at\.not\.is\.null/);
assert.match(ownerUi, /Owner Reconciliation/);
assert.match(monitor, /hasReturnVisitHistory/);
assert.match(monitor, /returnVisitCompleted/);
assert.match(monitor, /untrusted business data/);
assert.match(monitor, /2,000 characters/);

assert.match(paymentList, /amount_paid_cents/);
assert.match(paymentList, /totalPriceCents: isOwnerManual \? 0/);
assert.match(paymentRecorder, /OWNER_MANUAL_INVOICE_ALREADY_PAID/);
assert.match(trackApi, /Refunds reduce net retained revenue but do not silently create a new/);
assert.match(trackUi, /does not create a new amount due/);
assert.match(payoutApi, /notificationDelivered/);
assert.match(refundApi, /customer_refund_processed/);
assert.match(refundApi, /notificationError/);

assert.match(taxReport, /owner_manual_payment_events/);
assert.match(taxReport, /owner_manual_refund_events/);
assert.match(taxReport, /America\/Chicago/);
assert.match(taxReport, /taxableSalesRefundedCents/);
assert.match(taxReport, /bucket\(r\.filing_period\)/);
assert.match(ownerUi, /Planning reminder only/);

const refundBooking = {
  status: 'completed',
  source: 'owner_manual',
  payment_status: 'offline_recorded',
  payment_collected: false,
  refund_amount: 500,
  assembler_id: 'owner-easer',
  assembler_due: 20_000,
  payout_status: 'pending',
  payout_mode_snapshot: 'manual',
  payout_review_status: 'review_required',
};
let readiness = deriveManualPayoutReadiness(refundBooking, { owed: 20_000 });
assert.equal(readiness.disposition, 'on_hold');
assert.ok(readiness.holdCodes.includes('refund_review_incomplete'));
readiness = deriveManualPayoutReadiness({
  ...refundBooking,
  payout_review_status: 'approved_full',
  payout_reviewed_at: '2026-07-31T12:00:00.000Z',
  payout_reviewed_by: 'owner',
  payout_review_notes: 'Owner approved full canonical earnings.',
}, { owed: 20_000 });
assert.equal(readiness.disposition, 'pending');

const queryState = { gte: null };
const query = {
  select() { return this; },
  eq() { return this; },
  gte(_column, value) { queryState.gte = value; return this; },
  order() { return this; },
  limit() { return this; },
  async maybeSingle() {
    return {
      data: {
        id: 'evidence-1',
        evidence_type: 'completion_photo',
        uploaded_by: 'owner-easer',
        created_at: '2026-07-31T13:00:00.000Z',
      },
      error: null,
    };
  },
};
const sb = { from(table) { assert.equal(table, 'booking_evidence'); return query; } };
const historicalBooking = {
  id: 'booking-1',
  source: 'owner_manual',
  payment_status: 'offline_recorded',
  status: 'completed',
  assembler_id: 'owner-easer',
  completed_at: '2026-07-31T12:00:00.000Z',
  job_started_at: null,
};
const withoutHistoricalOption = await loadCurrentCompletionEvidence(sb, historicalBooking);
assert.equal(withoutHistoricalOption.evidence, null);
const withHistoricalOption = await loadCurrentCompletionEvidence(sb, historicalBooking, {
  allowHistoricalOwnerManual: true,
});
assert.equal(withHistoricalOption.evidence.id, 'evidence-1');
assert.equal(queryState.gte, historicalBooking.completed_at);

console.log('Owner dashboard audit regression checks: PASS');
