import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCurrentCompletionEvidence } from '../api/booking/_completion-evidence.js';
import { deriveManualPayoutReadiness } from '../api/owner/_finance-ledger.js';
import {
  allocateOperatingExpenses,
  summarizeKnownOperatingCosts,
  summarizeLaborCosting,
} from '../api/owner/financial-dashboard.js';
import { summarizeFinanceRows } from '../api/owner/_finance-ledger.js';

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
  marketDemandApi,
  assemblerListApi,
  casesApi,
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
  read('api/owner/market-demand.js'),
  read('api/assembler/list.js'),
  read('api/owner/cases.js'),
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
assert.match(ownerUi, /Total Platform Gross/);
assert.match(ownerUi, /Owner-Easer Labor/);
assert.match(ownerUi, /External Easer Labor/);
assert.match(ownerUi, /Jobs Missing Labor Cost/);
assert.match(ownerUi, /Known Operating Costs/);
assert.match(ownerUi, /Other Opex\/mo/);
assert.match(ownerUi, /Labor costing incomplete/);
assert.doesNotMatch(ownerUi, /Platform Gross After Tax, Stripe &amp; Easer/);
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
const payoutMutation = ownerUi.slice(
  ownerUi.indexOf("pendingAction.type === 'payout'"),
  ownerUi.indexOf("pendingAction.type === 'reject-assembler'"),
);
assert.match(payoutMutation, /await loadBookings\(true\);\s*await loadPayoutLedger\(\);\s*if \(selectedId\) selectBooking\(selectedId\);\s*loadLiveOps\(\);/);
assert.doesNotMatch(ownerUi, /id="test-push-btn"/);
assert.doesNotMatch(ownerUi, /deleteReview\(/);
assert.match(ownerUi, /s\.onlineReadyEasers \|\| 0/);
assert.doesNotMatch(ownerUi, /id="fin-assumption-reserve">2%/);
assert.match(ownerUi, /Add to Buffer Queue/);
assert.match(ownerUi, /Confirm Buffer queue/);
assert.match(ownerUi, /Generate and review this article copy/);
assert.match(ownerUi, /Copy preview:/);
assert.match(ownerUi, /No alerts found in this intelligence check/);
assert.match(ownerUi, /ownerManualNeedsAssignmentCount/);
assert.match(ownerUi, /Manual Payout Action/);
assert.match(ownerUi, /total_connect_pending/);
assert.match(ownerUi, /Automatic Payout Processing/);
assert.doesNotMatch(ownerUi, /id="nav-reviews"/);
assert.match(ownerUi, /Pending Confirmation/);
assert.match(ownerUi, /owner-responsive-table/);
assert.match(ownerUi, /MutationObserver/);
assert.match(ownerUi, /aria-haspopup="dialog"/);
assert.match(ownerUi, /md-approved-supply/);
assert.match(ownerUi, /connect-disabled/);
assert.doesNotMatch(ownerUi, /fin-assumption-processing">2\.9%/);
assert.doesNotMatch(ownerUi, /\{ label: 'Pending', val: s\.pendingPayment/);
assert.match(ownerUi, /fetch\('\/api\/assembler\/list', \{ headers: headers\(\) \}\)/);
assert.doesNotMatch(ownerUi, /api\/assembler\/list\?tier=pending/);
assert.match(marketDemandApi, /onlineReadyEasers/);
assert.match(assemblerListApi, /stats =/);
assert.match(casesApi, /ownerActionRequired/);

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

const thirtyDayOpex = allocateOperatingExpenses('all', 350_000, {
  rows: [{ eventAt: '2026-01-01T00:00:00.000Z' }],
  now: new Date('2026-01-31T00:00:00.000Z'),
});
assert.equal(thirtyDayOpex.days, 30);
assert.equal(thirtyDayOpex.cents, Math.round(350_000 * 30 / 365));
const explicitZeroOpex = allocateOperatingExpenses('all', 0, {
  rows: [{ eventAt: '2026-01-01T00:00:00.000Z' }],
  now: new Date('2026-01-31T00:00:00.000Z'),
});
assert.equal(explicitZeroOpex.days, 30);
assert.equal(explicitZeroOpex.cents, 0);
assert.deepEqual(allocateOperatingExpenses('all', 350_000, {
  rows: [],
  now: new Date('2026-01-31T00:00:00.000Z'),
}), {
  cents: 0,
  days: 0,
  from: null,
  to: '2026-01-31T00:00:00.000Z',
});

const beforeMailboxStart = summarizeKnownOperatingCosts('all', {}, new Date('2026-07-31T18:00:00.000Z'));
assert.equal(beforeMailboxStart.recognizedCents, 0);
assert.equal(beforeMailboxStart.monthlyRunRateCents, 798);
assert.equal(beforeMailboxStart.items[0].nextChargeDate, '2026-08-01');
const firstMailboxPayment = summarizeKnownOperatingCosts('all', {}, new Date('2026-08-01T18:00:00.000Z'));
assert.equal(firstMailboxPayment.recognizedCents, 798);
assert.equal(firstMailboxPayment.confirmedCents, 798);
assert.equal(firstMailboxPayment.scheduledAssumptionCents, 0);
assert.equal(firstMailboxPayment.items[0].nextChargeDate, '2026-09-01');
const firstRecurringMailboxCharge = summarizeKnownOperatingCosts('all', {}, new Date('2026-09-01T18:00:00.000Z'));
assert.equal(firstRecurringMailboxCharge.recognizedCents, 1_596);
assert.equal(firstRecurringMailboxCharge.confirmedCents, 798);
assert.equal(firstRecurringMailboxCharge.scheduledAssumptionCents, 798);
assert.equal(firstRecurringMailboxCharge.items[0].nextChargeDate, '2026-10-01');

const laborCosting = summarizeLaborCosting([
  {
    status: 'completed', ref: 'AAE-KELLY', assemblerId: 'owner-easer',
    netCharged: 37_400, taxCollected: 2_850, stripeFee: 1_020, owed: 24_550,
  },
  {
    status: 'completed', ref: 'AAE-VAIBHAV', assemblerId: 'external-easer',
    netCharged: 11_000, taxCollected: 838, stripeFee: 349, paidOut: true, payoutAmount: 7_113,
  },
  {
    status: 'completed', ref: 'AAE-BARRY', assemblerId: null,
    netCharged: 15_300, taxCollected: 1_166, stripeFee: 474, owed: 0,
  },
], new Set(['owner-easer']));
assert.equal(laborCosting.ownerEaserEarnings, 24_550);
assert.equal(laborCosting.externalEaserEarnings, 7_113);
assert.equal(laborCosting.costedCompletedJobs, 2);
assert.equal(laborCosting.costedPlatformGrossProfit, 11_680);
assert.equal(laborCosting.costedGrossProfitPerJob, 5_840);
assert.equal(laborCosting.uncostedCompletedJobs, 1);
assert.equal(laborCosting.uncostedPlatformGross, 13_660);
assert.deepEqual(laborCosting.uncostedRefs, ['AAE-BARRY']);

const payoutSummary = summarizeFinanceRows([
  { payoutDisposition: 'pending', payoutMode: 'manual', owed: 1_000 },
  { payoutDisposition: 'pending', payoutMode: 'stripe_connect', owed: 2_000 },
  { payoutDisposition: 'on_hold', payoutMode: 'manual', owed: 3_000 },
]);
assert.equal(payoutSummary.pendingPayouts, 6_000);
assert.equal(payoutSummary.payablePayouts, 1_000);
assert.equal(payoutSummary.connectPendingPayouts, 2_000);
assert.equal(payoutSummary.heldPayouts, 3_000);

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
