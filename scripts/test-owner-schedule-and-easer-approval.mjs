import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import {
  hasCurrentEaserAgreement,
  isActiveApprovedEaserProfile,
  isAssignedWorkEaserProfile,
} from '../api/_easer-access.js';
import {
  getEaserApprovalReadiness,
  getEaserReadiness,
} from '../api/_easer-readiness.js';
import { chicagoTodayIso } from '../api/booking/_appt-date.js';

const paidApplication = {
  role: 'assembler',
  status: 'pending',
  application_status: 'applied',
  tier: null,
  is_available: false,
  identity_verified: true,
  application_fee_paid: true,
  payment_confirmed: true,
  application_fee_waived: false,
  fee_waived_by_owner: false,
  application_fee_refunded: false,
  application_fee_refunded_cents: 0,
  application_fee_refund_pending_cents: 0,
  application_fee_refund_review_required_at: null,
  account_closure_status: null,
};

// A contract update may never disable the owner's approval decision.
const outdatedAgreementApplicant = {
  ...paidApplication,
  contractor_agreement_signed_at: '2026-06-01T12:00:00.000Z',
  contractor_agreement_version: '2026-06-01',
  code_of_conduct_agreed_at: '2026-06-01T12:00:00.000Z',
};
const approval = getEaserApprovalReadiness(outdatedAgreementApplicant);
assert.equal(approval.isApprovable, true);
assert.deepEqual(approval.missingItems, []);

// Approval still does not make an outdated agreement eligible for new work.
const approvedOutdated = {
  ...outdatedAgreementApplicant,
  status: 'active',
  application_status: 'approved',
  tier: 'starter',
  phone: '737-555-0100',
};
const jobReadiness = await getEaserReadiness(approvedOutdated, {
  connectRequired: false,
  requireAvailability: false,
});
assert.equal(jobReadiness.isReady, false);
assert.equal(jobReadiness.agreementCurrent, false);
assert.ok(jobReadiness.missingItems.some(item => item.includes('Current contractor agreement')));
assert.equal(hasCurrentEaserAgreement(approvedOutdated), false);
assert.equal(isActiveApprovedEaserProfile(approvedOutdated), false);

// Existing accepted work remains accessible so an agreement update cannot
// strand a customer, but this predicate grants no new-offer capability.
assert.equal(isAssignedWorkEaserProfile(approvedOutdated), true);

const approvedCurrent = {
  ...approvedOutdated,
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
};
assert.equal(hasCurrentEaserAgreement(approvedCurrent), true);
assert.equal(isActiveApprovedEaserProfile(approvedCurrent), true);

assert.equal(getEaserApprovalReadiness({
  ...outdatedAgreementApplicant,
  identity_verified: false,
}).isApprovable, false);
assert.equal(getEaserApprovalReadiness({
  ...outdatedAgreementApplicant,
  application_fee_refunded: true,
}).isApprovable, false);
assert.equal(getEaserApprovalReadiness({
  ...outdatedAgreementApplicant,
  payment_confirmed: false,
}).isApprovable, false);

// Austin business date, not UTC date, owns every "Today" schedule.
assert.equal(chicagoTodayIso(new Date('2026-07-29T00:30:00.000Z')), '2026-07-28');
assert.equal(chicagoTodayIso(new Date('2026-07-29T06:00:00.000Z')), '2026-07-29');

const [
  updateSource,
  liveOpsSource,
  monitorSource,
  cronSource,
  ownerSource,
  createBookingSource,
  migrationSource,
  liveReadinessSource,
] = await Promise.all([
  readFile(new URL('../api/assembler/update.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/monitor.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/cron/ops-alert.js', import.meta.url), 'utf8'),
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/create-booking.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/043_separate_easer_approval_from_job_readiness.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/live-readiness-check.js', import.meta.url), 'utf8'),
]);

assert.match(updateSource, /getEaserApprovalReadiness\(profile\)/);
assert.match(updateSource, /finalize_easer_application_approval/);
assert.match(updateSource, /requiresCurrentAgreement/);
assert.match(updateSource, /Review the current contractor agreement/);
assert.match(updateSource, /before trying to go Online or receive a new job offer/);

assert.match(liveOpsSource, /chicagoTodayIso\(now\)/);
assert.match(liveOpsSource, /ownerManualNeedsAssignment/);
assert.match(liveOpsSource, /isOwnerManualOfflineBooking\(b\)/);
assert.match(monitorSource, /chicagoTodayIso\(now\)/);
assert.match(monitorSource, /ownerManualNeedsAssignmentCount/);
assert.match(monitorSource, /No zero-value report was generated/);
assert.match(monitorSource, /No financial summary was generated/);
assert.match(cronSource, /chicagoTodayIso\(new Date\(now\)\)/);
assert.match(cronSource, /isOwnerManualOfflineBooking\(b\)/);

assert.match(ownerSource, /ownerBusinessDate/);
assert.match(ownerSource, /America\/Chicago/);
assert.match(ownerSource, /owner_manual_assignment/);
assert.match(ownerSource, /Automatic marketplace dispatch is intentionally disabled/);
assert.match(ownerSource, /MANUAL PAYOUT/);
assert.match(ownerSource, /Timeline is incomplete/);
assert.match(ownerSource, /Service Subtotal/);
assert.match(ownerSource, /Platform Gross/);
assert.match(ownerSource, /Approval and job readiness are separate/);
assert.match(ownerSource, /easerApprovalFeeSatisfied/);

assert.match(createBookingSource, /eventType: 'confirmed'/);
assert.match(createBookingSource, /eventType: 'payment_collected'/);
assert.match(createBookingSource, /customer confirmation failed after booking save/);
assert.match(createBookingSource, /completion email failed after booking save/);
assert.match(createBookingSource, /confirmationEmailError/);

const approvalFunction = migrationSource.slice(
  migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.finalize_easer_application_approval'),
  migrationSource.indexOf('REVOKE ALL ON FUNCTION public.finalize_easer_application_approval'),
);
assert.ok(approvalFunction.length > 0);
assert.doesNotMatch(approvalFunction, /contractor_agreement/);
assert.match(approvalFunction, /identity_verified IS NOT TRUE/);
assert.match(approvalFunction, /is_available = FALSE/);
assert.match(migrationSource, /contractor_agreement_version IS DISTINCT FROM '2026-07-13'/);
assert.match(migrationSource, /profiles_guard_current_agreement_online/);
assert.match(migrationSource, /SET is_available = FALSE/);
assert.match(liveReadinessSource, /REQUIRED_SCHEMA_MIGRATION = 53/);
assert.match(liveReadinessSource, /Apply migrations 038-053 in order/);
assert.equal((migrationSource.match(/^BEGIN;$/gm) || []).length, 1);
assert.equal((migrationSource.match(/^COMMIT;$/gm) || []).length, 1);
assert.equal((migrationSource.match(/\$\$/g) || []).length % 2, 0);

console.log('Owner schedule, manual-job visibility, and Easer approval separation tests: PASS');
