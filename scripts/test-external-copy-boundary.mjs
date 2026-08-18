#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { toEaserEarningDto } from '../api/assembler/_earnings.js';
import { toPublicEaserReadiness } from '../api/assembler/readiness.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const holdCodes = [
  'offline_payment_not_verified',
  'customer_payment_uncaptured',
  'cancellation_payment_uncaptured',
  'completion_evidence_missing',
  'refund_review_incomplete',
  'damage_review_open',
  'damage_review_incomplete',
  'customer_dispute_open',
  'financial_reconciliation_open',
  'return_visit_open',
  'stripe_connect_path',
  'stripe_transfer_exists',
  'payout_mode_missing',
  'payout_state_reconciliation',
  'easer_not_assigned',
];
const allowedPublicCodes = new Set([
  'on_hold',
  'action_required',
  'pending',
  'processing',
  'paid',
  'unavailable',
]);
const internalLanguage = /owner|admin|internal|dispatch|finance|operations|payment verification|payment collection|manual review|stripe|reconcil|reported job issue|release this earning/i;

for (const holdCode of holdCodes) {
  const earning = toEaserEarningDto({
    bookingId: '11111111-1111-4111-8111-111111111111',
    ref: 'AAE-PUBLIC01',
    service: 'Furniture Assembly',
    eventAt: '2026-07-31T12:00:00.000Z',
    owed: 24550,
    payoutStatus: 'pending',
    payoutMode: 'manual',
    payoutDisposition: 'on_hold',
    payoutHoldCodes: [holdCode],
  });
  assert.ok(allowedPublicCodes.has(earning.payout.status_code), `${holdCode} must map to a public status code`);
  assert.doesNotMatch(earning.payout.status_label, internalLanguage, `${holdCode} leaked through its label`);
  assert.doesNotMatch(earning.payout.status_message, internalLanguage, `${holdCode} leaked through its message`);
}

const publicReadiness = toPublicEaserReadiness({
  isReady: false,
  agreementCurrent: true,
  codeOfConductAccepted: true,
  missingItems: [
    'Owner approved',
    'Stripe Connect status verified',
    'Stripe requirements due: 2',
  ],
});
assert.deepEqual(publicReadiness, {
  isReady: false,
  agreementCurrent: true,
  codeOfConductAccepted: true,
  missingItems: ['Application approved', 'Payout setup complete'],
  accountStatus: null,
  suspended: false,
});
assert.doesNotMatch(JSON.stringify(publicReadiness), internalLanguage);

const [
  rules,
  jobsPage,
  payoutsPage,
  applyPage,
  verifyPage,
  assignmentsApi,
  statusApi,
  completionApi,
  dropApi,
  declineApi,
  feeFinalizeApi,
  readinessApi,
  uploadEvidenceApi,
  messageApi,
  customerCancelApi,
  guestCancelApi,
  rescheduleApi,
  paymentRecoveryApi,
  requestClosureApi,
  cancelClosureApi,
  connectLinkApi,
  connectLoginApi,
  profilePage,
  ownerPage,
] = await Promise.all([
  read('AGENTS.md'),
  read('assembler/my-assignments.html'),
  read('assembler/payouts.html'),
  read('assembler/apply.html'),
  read('assembler/verify-identity.html'),
  read('api/booking/my-assignments.js'),
  read('api/booking/easer-status.js'),
  read('api/booking/assembler-complete.js'),
  read('api/booking/drop-job.js'),
  read('api/booking/decline-dispatch.js'),
  read('api/assembler/application-fee-finalize.js'),
  read('api/assembler/readiness.js'),
  read('api/booking/upload-evidence.js'),
  read('api/booking/message.js'),
  read('api/booking/customer-cancel.js'),
  read('api/booking/guest-cancel.js'),
  read('api/booking/reschedule.js'),
  read('api/booking/payment-recovery.js'),
  read('api/assembler/request-account-closure.js'),
  read('api/assembler/cancel-account-closure.js'),
  read('api/assembler/connect-link.js'),
  read('api/assembler/connect-login.js'),
  read('assembler/profile.html'),
  read('owner/index.html'),
]);

assert.match(rules, /## External-Facing Copy Boundary/);
assert.match(rules, /Detailed internal reasons[\s\S]*belong in owner APIs, owner dashboards, audit logs/);

for (const [name, source] of [
  ['Easer Jobs', jobsPage],
  ['Easer Earnings', payoutsPage],
  ['Easer application', applyPage],
  ['Easer identity', verifyPage],
]) {
  for (const oldCopy of [
    'Owner Review',
    'Payment Verification',
    'reported job issue',
    'Report damage or an onsite incident',
    'Payment captured and customer notified',
    'Record customer collection separately in the owner dashboard',
    'owner approval',
    'Job update from dispatcher',
    'New message from dispatch',
    'dispatch updates in the app',
    'dispatch matching',
  ]) {
    assert.equal(source.toLowerCase().includes(oldCopy.toLowerCase()), false, `${name} still contains: ${oldCopy}`);
  }
}

assert.match(jobsPage, /Payout Amount/);
assert.match(jobsPage, /Action Required: Completion Photo/);
assert.match(jobsPage, /Report an Issue/);
assert.match(jobsPage, /Your payout status is available in Earnings/);
assert.doesNotMatch(jobsPage, /_owner_manual_live_flow/);

assert.match(assignmentsApi, /const INTERNAL_FINANCIAL_FIELDS = \[/);
assert.match(assignmentsApi, /INTERNAL_FINANCIAL_FIELDS\.forEach\(field => \{ delete booking\[field\]; \}\)/);
assert.match(assignmentsApi, /_can_self_drop = !isOwnerManualLiveFlow/);
assert.doesNotMatch(assignmentsApi, /_owner_manual_live_flow/);
assert.match(assignmentsApi, /New job offers are temporarily paused/);

assert.match(statusApi, /return res\.status\(200\)\.json\(\{ ok: true, stage, label \}\)/);
assert.doesNotMatch(completionApi, /reconciliationRequired|destinationAccount|Total charged to customer|Platform fee \(/);
assert.match(completionApi, /Payout Amount/);
assert.match(completionApi, /Status: Pending/);

const dropResponse = dropApi.slice(dropApi.lastIndexOf('return res.status(200).json'));
assert.match(dropResponse, /You will not receive further updates for this assignment/);
assert.doesNotMatch(dropResponse, /redispatch|dispatchAction|warning|owner review|customer payment/i);

const declineResponse = declineApi.slice(declineApi.lastIndexOf('return res.status(200).json'));
assert.match(declineResponse, /You will not receive further offers for this job/);
assert.doesNotMatch(declineResponse, /dispatchAction|warning|owner review/i);

for (const oldPublicError of [
  'requires owner reconciliation',
  'under owner review',
  'blocked for owner review',
  'Stripe has not confirmed the application fee',
  'Stripe confirmed payment could not be reconciled',
]) {
  assert.equal(feeFinalizeApi.includes(oldPublicError), false, `Application payment response still contains: ${oldPublicError}`);
}

assert.match(readinessApi, /readiness: toPublicEaserReadiness\(readiness\)/);
assert.match(readinessApi, /Application approved/);
assert.match(readinessApi, /Payout setup complete/);

const uploadResponse = uploadEvidenceApi.slice(uploadEvidenceApi.lastIndexOf('return res.status(201).json'));
assert.match(uploadResponse, /Your issue report was received/);
assert.doesNotMatch(uploadResponse, /ownerNotified|damageReviewStatus|warning|owner review|notification/i);

assert.match(messageApi, /if \(resolvedSender === 'owner'\) \{[\s\S]*response\.notification/);
assert.doesNotMatch(messageApi, /Job update from dispatcher|New message from dispatch/);

for (const cancellationApi of [customerCancelApi, guestCancelApi]) {
  assert.doesNotMatch(cancellationApi, /requires owner-assisted cancellation/);
  assert.doesNotMatch(cancellationApi, /We could not fully reconcile the payment portion/);
  assert.match(cancellationApi, /Your booking remains unchanged/);
}

const rescheduleResponse = rescheduleApi.slice(rescheduleApi.lastIndexOf('return res.status(200).json'));
assert.doesNotMatch(rescheduleResponse, /notificationFailures|notificationAuditFailures|easerReconfirmationRequired/);
assert.match(rescheduleApi, /temporarily unavailable for rescheduling/);

assert.doesNotMatch(paymentRecoveryApi, /publicError: 'Stripe|error: 'Stripe could not continue/);

for (const closureApi of [requestClosureApi, cancelClosureApi]) {
  const closureResponse = closureApi.slice(closureApi.lastIndexOf('return res.status(200).json'));
  assert.doesNotMatch(closureResponse, /ownerNotified|warning|notification/i);
}
assert.doesNotMatch(profilePage, /support notification failed|support will review the request/);
assert.doesNotMatch(profilePage, /dispatch basics|dispatch and support details/);
assert.match(profilePage, /We will email you when the status changes/);

assert.doesNotMatch(connectLinkApi, /error: 'Stripe/);
const connectLinkResponse = connectLinkApi.slice(connectLinkApi.lastIndexOf('return res.status(200).json'));
assert.doesNotMatch(connectLinkResponse, /accountId|expiresAt/);
assert.doesNotMatch(connectLoginApi, /error: 'Stripe|Stripe dashboard/);

// Internal owner visibility remains detailed; the boundary must not erase it.
assert.match(ownerPage, /Customer Total/);
assert.match(ownerPage, /Processing Fee/);
assert.match(ownerPage, /Platform Fee/);
assert.match(ownerPage, /Easer Earnings/);

console.log('External-facing copy boundary tests: PASS');
