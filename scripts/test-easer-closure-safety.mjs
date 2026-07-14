import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { isActiveApprovedEaserProfile } from '../api/_easer-access.js';
import {
  BLOCKING_EASER_CLOSURE_STATUSES,
  isEaserClosureBlocking,
  normalizeEaserClosureStatus,
} from '../api/_easer-closure.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';

const readyProfile = {
  id: 'easer-closure-test',
  role: 'assembler',
  status: 'active',
  application_status: 'approved',
  tier: 'starter',
  phone: '512-555-0100',
  is_available: true,
  identity_verified: true,
  contractor_agreement_signed_at: '2026-07-13T12:00:00.000Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-07-13T12:00:00.000Z',
  application_fee_paid: true,
  application_fee_waived: false,
  fee_waived_by_owner: false,
  application_fee_refunded: false,
  account_closure_status: null,
};

assert.deepEqual(
  [...BLOCKING_EASER_CLOSURE_STATUSES],
  ['requested', 'reviewing', 'completed'],
  'the shared predicate must use the complete closure hold set',
);
assert.equal(normalizeEaserClosureStatus({ account_closure_status: ' Reviewing ' }), 'reviewing');
assert.equal(normalizeEaserClosureStatus(''), null);
assert.equal(isEaserClosureBlocking(null), false);
assert.equal(isEaserClosureBlocking('cancelled'), false);
assert.equal(isActiveApprovedEaserProfile(readyProfile), true);

const manualReady = await getEaserReadiness(readyProfile, { connectRequired: false });
assert.equal(manualReady.isReady, true, 'manual payout launch must not require Stripe Connect');

for (const closureStatus of BLOCKING_EASER_CLOSURE_STATUSES) {
  const heldProfile = { ...readyProfile, account_closure_status: closureStatus };
  assert.equal(isEaserClosureBlocking(heldProfile), true);
  assert.equal(
    isActiveApprovedEaserProfile(heldProfile),
    false,
    `${closureStatus} closure must block authenticated Easer job access`,
  );
  const readiness = await getEaserReadiness(heldProfile, { connectRequired: false });
  assert.equal(readiness.isReady, false, `${closureStatus} closure must block dispatch readiness`);
  assert.equal(readiness.accountClosureBlocking, true);
  assert.ok(readiness.missingItems.includes(`Account closure ${closureStatus}`));
}

const cancelledReadiness = await getEaserReadiness({
  ...readyProfile,
  account_closure_status: 'cancelled',
}, { connectRequired: false });
assert.equal(cancelledReadiness.isReady, true, 'a cancelled closure request returns to ordinary readiness checks');

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  accessSource,
  readinessSource,
  dispatchSource,
  assignSource,
  closureRequestSource,
  feeFinalizeSource,
  applySource,
  ownerUpdateSource,
  migrationSource,
] = await Promise.all([
  load('api/_easer-access.js'),
  load('api/_easer-readiness.js'),
  load('api/booking/_dispatch-internal.js'),
  load('api/booking/assign.js'),
  load('api/assembler/request-account-closure.js'),
  load('api/assembler/application-fee-finalize.js'),
  load('api/assembler/apply.js'),
  load('api/assembler/update.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
]);

assert.match(accessSource, /isEaserClosureBlocking\(profile\)/);
// The access guard projection must read both the application-fee refund state
// and the account-closure state (plus the refund-detail columns added later).
assert.match(accessSource, /application_fee_refunded[,_]/);
assert.match(accessSource, /account_closure_status/);
assert.match(readinessSource, /accountClosureBlocking: isEaserClosureBlocking/);

for (const source of [dispatchSource, assignSource]) {
  assert.match(source, /application_fee_paid/);
  assert.match(source, /application_fee_waived/);
  assert.match(source, /fee_waived_by_owner/);
  assert.match(source, /application_fee_refunded/);
  assert.match(source, /account_closure_status/);
}
assert.match(dispatchSource, /account_closure_status\.is\.null,account_closure_status\.eq\.cancelled/);

assert.match(closureRequestSource, /\.rpc\(\s*['"]request_easer_account_closure['"]/);
assert.match(closureRequestSource, /ACCOUNT_ALREADY_CLOSED/);
assert.match(closureRequestSource, /alreadyRequested: true/);
assert.doesNotMatch(
  closureRequestSource,
  /from\(['"]bookings['"]\)/,
  'closure eligibility and transition must be one database transaction',
);

assert.match(feeFinalizeSource, /isEaserClosureBlocking\(profile\)/);
assert.match(feeFinalizeSource, /\.eq\(['"]status['"], ['"]pending['"]\)/);
assert.match(feeFinalizeSource, /account_closure_status\.is\.null,account_closure_status\.eq\.cancelled/);
assert.match(feeFinalizeSource, /APPLICATION_FEE_FINALIZATION_CLOSED/);
assert.match(applySource, /isEaserClosureBlocking\(profile\)/);
assert.match(applySource, /account_closure_status\.is\.null,account_closure_status\.eq\.cancelled/);
assert.ok(
  applySource.indexOf(".update({ application_status: 'applied' })")
    < applySource.indexOf('ensureFinalizationIdentityToken(sb, finalizedProfile)'),
  'the authoritative closure-aware transition must win before rotating an identity token',
);

assert.match(ownerUpdateSource, /ACCOUNT_CLOSURE_BLOCKS_ACTION/);
assert.match(ownerUpdateSource, /claim_easer_application_decision/);
assert.match(ownerUpdateSource, /finalize_easer_application_decision/);
assert.match(ownerUpdateSource, /suspend_easer_if_no_active_jobs/);
assert.match(migrationSource, /easer_application_decision_snapshot\(v_profile\)/);
assert.match(migrationSource, /FROM public\.profiles[\s\S]*FOR UPDATE/);
assert.match(migrationSource, /A closure-held Easer cannot receive or retain a live assignment/);
assert.match(ownerUpdateSource, /loadLedgerFirstFinanceRows/);
assert.match(ownerUpdateSource, /EASER_UNPAID_EARNINGS/);
assert.match(ownerUpdateSource, /APPLICATION_REJECTION_REQUIRED/);
assert.match(ownerUpdateSource, /APPLICATION_STATE_MISMATCH/);
assert.match(ownerUpdateSource, /retry_auth_revoke/);
assert.match(ownerUpdateSource, /AUTH_ACCESS_REVOCATION_FAILED/);
assert.match(ownerUpdateSource, /auth_access_revoke_error/);
assert.match(ownerUpdateSource, /account_closure_completed_at/);
assert.match(ownerUpdateSource, /account_closure_completed_by/);

assert.match(migrationSource, /CREATE OR REPLACE FUNCTION public\.request_easer_account_closure/);
assert.match(migrationSource, /FOR UPDATE/);
assert.match(migrationSource, /bookings_guard_easer_closure_assignment/);
assert.match(migrationSource, /profiles_guard_easer_closure_state/);
assert.match(migrationSource, /A completed account closure is terminal/);
assert.match(migrationSource, /Account closure cannot complete while Easer earnings remain unpaid/);

console.log('Easer closure safety tests: PASS');
