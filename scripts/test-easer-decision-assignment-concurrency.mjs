import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [updateSource, assignSource, acceptSource, migrationSource, refundTruthSource] = await Promise.all([
  load('api/assembler/update.js'),
  load('api/booking/assign.js'),
  load('api/booking/accept-dispatch.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
  load('api/_easer-application-refund.js'),
]);

function validatePostgresStructure(source) {
  let state = 'normal';
  let dollarTag = null;
  let blockCommentDepth = 0;
  let parentheses = 0;
  let statements = 0;

  for (let i = 0; i < source.length; i += 1) {
    const current = source[i];
    const next = source[i + 1];
    if (state === 'line-comment') {
      if (current === '\n') state = 'normal';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockCommentDepth += 1;
        i += 1;
      } else if (current === '*' && next === '/') {
        blockCommentDepth -= 1;
        i += 1;
        if (blockCommentDepth === 0) state = 'normal';
      }
      continue;
    }
    if (state === 'single-quote') {
      if (current === "'" && next === "'") i += 1;
      else if (current === "'") state = 'normal';
      continue;
    }
    if (state === 'double-quote') {
      if (current === '"' && next === '"') i += 1;
      else if (current === '"') state = 'normal';
      continue;
    }
    if (state === 'dollar-quote') {
      if (source.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = null;
        state = 'normal';
      }
      continue;
    }

    if (current === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
    } else if (current === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      i += 1;
    } else if (current === "'") {
      state = 'single-quote';
    } else if (current === '"') {
      state = 'double-quote';
    } else if (current === '$') {
      const match = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        state = 'dollar-quote';
        i += dollarTag.length - 1;
      }
    } else if (current === '(') {
      parentheses += 1;
    } else if (current === ')') {
      parentheses -= 1;
      assert.ok(parentheses >= 0, `SQL has an unmatched closing parenthesis at byte ${i}`);
    } else if (current === ';' && parentheses === 0) {
      statements += 1;
    }
  }

  assert.equal(state, 'normal', `SQL ended inside ${state}`);
  assert.equal(blockCommentDepth, 0, 'SQL block comments must be balanced');
  assert.equal(parentheses, 0, 'SQL parentheses must be balanced');
  assert.ok(statements > 50, 'migration parser found too few complete statements');
}

validatePostgresStructure(migrationSource);
assert.equal((migrationSource.match(/^BEGIN;$/gm) || []).length, 1, 'migration must have one outer transaction');
assert.equal((migrationSource.match(/^COMMIT;$/gm) || []).length, 1, 'migration must commit once');
assert.equal((migrationSource.match(/\$\$/g) || []).length % 2, 0, 'SQL dollar-quoted bodies must be balanced');

function section(source, startMarker, endMarker, { last = false } = {}) {
  const start = last ? source.lastIndexOf(startMarker) : source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing section end after: ${startMarker}`);
  return source.slice(start, end);
}

// One durable tuple owns an approve/reject operation and supports crash-safe
// retry with the same operation key.
assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS application_decision_key TEXT/);
assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ/);
assert.match(migrationSource, /profiles_application_decision_tuple_check/);
assert.match(migrationSource, /idx_profiles_application_decision_key_unique/);
const claimSql = section(
  migrationSource,
  'CREATE OR REPLACE FUNCTION public.claim_easer_application_decision',
  'REVOKE ALL ON FUNCTION public.claim_easer_application_decision',
);
assert.match(claimSql, /FOR UPDATE/);
assert.match(claimSql, /easer_application_decision_snapshot\(v_profile\)[\s\S]*p_expected_snapshot/);
assert.match(claimSql, /application_decision_type = v_decision[\s\S]*application_decision_key = v_operation_key/);
assert.match(claimSql, /ERRCODE = '55P03'/);
assert.match(claimSql, /Finalized approval fee or refund truth is inconsistent/);
assert.match(claimSql, /application_fee_paid IS NOT TRUE[\s\S]*payment_confirmed IS NOT TRUE[\s\S]*stripe_payment_intent_id IS NULL THEN/);

const finalizeSql = section(
  migrationSource,
  'CREATE OR REPLACE FUNCTION public.finalize_easer_application_decision',
  'REVOKE ALL ON FUNCTION public.finalize_easer_application_decision',
);
assert.match(finalizeSql, /FOR UPDATE/);
assert.match(finalizeSql, /application_decision_type IS DISTINCT FROM v_decision/);
assert.match(finalizeSql, /application_decision_key IS DISTINCT FROM v_operation_key/);
assert.match(finalizeSql, /easer_application_decision_snapshot\(v_profile\)[\s\S]*p_expected_snapshot/);
for (const readinessTruth of [
  'application_status',
  'identity_verified',
  'contractor_agreement_signed_at',
  'contractor_agreement_version',
  'code_of_conduct_agreed_at',
  'phone',
  'account_closure_status',
  'application_fee_paid',
  'payment_confirmed',
  'application_fee_refunded',
  'stripe_payment_intent_id',
  'stripe_customer_id',
  'approved_at',
]) {
  assert.match(finalizeSql, new RegExp(readinessTruth));
}
const rejectedUpdate = finalizeSql.indexOf("SET status = 'rejected'");
const rejectionClaimClear = finalizeSql.indexOf('application_decision_key = NULL', rejectedUpdate);
assert.ok(
  rejectedUpdate > 0 && rejectionClaimClear > rejectedUpdate,
  'rejection status and decision-claim release must commit in one profile update',
);
// Refund truth is committed earlier by reconcileEaserApplicationFeeRefund; the
// finalize RPC re-validates it as a fail-closed precondition and refuses to
// reject a paid application unless the profile already holds the exact aggregate
// refund (3000c refunded, 0 pending, review flag set, matching refund id).
assert.match(finalizeSql, /application_fee_refunded_cents, 0\) <> 3000/);
assert.match(finalizeSql, /application_fee_refund_id IS DISTINCT FROM v_refund_id/);
assert.match(finalizeSql, /Paid application rejection requires a completed aggregate Stripe refund/);

const releaseSql = section(
  migrationSource,
  'CREATE OR REPLACE FUNCTION public.release_easer_application_decision',
  'REVOKE ALL ON FUNCTION public.release_easer_application_decision',
);
assert.match(releaseSql, /FOR UPDATE/);
assert.match(releaseSql, /application_decision_type = LOWER\(BTRIM\(p_decision\)\)/);
assert.match(releaseSql, /application_decision_key = BTRIM\(p_operation_key\)/);

// Approval reuses a surviving claim after a process crash. A response lost
// after finalization begins must not release that claim blindly.
const approveRoute = section(updateSource, "if (action === 'approve')", '// ── REJECT');
assert.match(approveRoute, /const resumingApproval = rawProfile\.application_decision_type === decision/);
assert.match(approveRoute, /resumingApproval[\s\S]*rawProfile\.application_decision_key[\s\S]*applicationDecisionKey/);
const finalApprovalStripeRead = approveRoute.lastIndexOf('verifyApprovalStripeTruth');
assert.ok(approveRoute.indexOf('claimApplicationDecision') < finalApprovalStripeRead);
assert.ok(finalApprovalStripeRead < approveRoute.indexOf('finalizeApplicationDecision'));
assert.match(approveRoute, /approvalFinalizationStarted = true;[\s\S]*finalizeApplicationDecision/);
assert.match(approveRoute, /if \(!approvalFinalizationStarted \|\| deterministicDatabaseRollback\)[\s\S]*releaseApplicationDecision/);
assert.match(approveRoute, /\['40001', '23514'\]\.includes\(approveError\?\.code\)/);
assert.match(approveRoute, /profile\.status === 'active'[\s\S]*verifyApprovalStripeTruth\(rawProfile, assemblerId\)/);
const approvalVerifier = section(
  updateSource,
  'async function verifyApprovalStripeTruth',
  '/**',
);
// Paid-approval Stripe proof is centralized in loadEaserApplicationFeeRefundTruth
// (retrieves the PaymentIntent, requires consent, lists refunds with has_more
// pagination, and reports live refund activity). The waived branch independently
// retrieves + validates a canceled intent. Approval must fail on refund activity.
assert.match(approvalVerifier, /loadEaserApplicationFeeRefundTruth/);
assert.match(approvalVerifier, /refundTruth\.hasLiveRefundActivity/);
assert.match(approvalVerifier, /paymentIntents\.retrieve/);
assert.match(approvalVerifier, /validateEaserApplicationPaymentIntent/);
assert.match(approvalVerifier, /feeWaived && profile\.payment_confirmed === true/);
// The centralized helper must retrieve the PaymentIntent before listing refunds,
// require fee consent, and fail closed on unbounded refund pages.
assert.ok(refundTruthSource.indexOf('paymentIntents.retrieve') < refundTruthSource.indexOf('refunds.list'));
assert.match(refundTruthSource, /requireConsent: true/);
assert.match(refundTruthSource, /has_more === true/);

// Rejection owns the row before Stripe is touched, records a single canonical
// refund only in the final RPC, and retains its claim after mutation/ambiguity.
const rejectRoute = section(updateSource, "if (action === 'reject')", '// ── SUSPEND');
assert.ok(rejectRoute.indexOf('claimApplicationDecision') < rejectRoute.indexOf('stripe.refunds.create'));
assert.ok(rejectRoute.indexOf('claimApplicationDecision') < rejectRoute.indexOf('stripe.paymentIntents.cancel'));
// Refund truth (including has_more pagination) is loaded through the centralized
// helper asserted above; the reject route delegates to it rather than paging inline.
assert.match(rejectRoute, /loadEaserApplicationFeeRefundTruth/);
assert.match(rejectRoute, /stripeMutationStarted = true;[\s\S]*stripe\.refunds\.create/);
assert.match(rejectRoute, /stripeMutationStarted = true;[\s\S]*stripe\.paymentIntents\.cancel/);
assert.match(rejectRoute, /resumingRejection \|\| stripeMutationStarted \|\| stripeFinancialActivityObserved/);
// The decision claim (type + operation key) is persisted atomically by the
// row-locked claim_easer_application_decision RPC, not an inline profile update.
assert.match(rejectRoute, /claimApplicationDecision\(sb, \{[\s\S]*decision,[\s\S]*operationKey,/);
assert.ok(rejectRoute.indexOf('loadRawEaserProfile') < rejectRoute.indexOf('finalizeApplicationDecision'));
assert.doesNotMatch(rejectRoute, /application_fee_refunded:\s*true/);
assert.doesNotMatch(rejectRoute, /\.update\(rejectionUpdates\)/);
for (const mismatchMarker of [
  'Application refund records are contradictory.',
  'has no stored Stripe PaymentIntent.',
]) {
  const mismatch = rejectRoute.indexOf(mismatchMarker);
  assert.ok(mismatch > 0, `Missing rejection ambiguity guard: ${mismatchMarker}`);
  const precedingBlock = rejectRoute.slice(Math.max(0, mismatch - 500), mismatch);
  assert.doesNotMatch(precedingBlock, /releaseDefinitivelySafeRejection/);
}

// The booking trigger is the final row-locked readiness authority for owner
// assignment, dispatch acceptance, and legacy token acceptance.
const assignmentGuardSql = section(
  migrationSource,
  'CREATE OR REPLACE FUNCTION public.guard_booking_easer_closure_assignment',
  'REVOKE ALL ON FUNCTION public.guard_booking_easer_closure_assignment',
  { last: true },
);
assert.match(assignmentGuardSql, /FROM public\.profiles[\s\S]*FOR UPDATE/);
for (const readinessTruth of [
  "status IS DISTINCT FROM 'active'",
  "application_status IS DISTINCT FROM 'approved'",
  'identity_verified IS NOT TRUE',
  'contractor_agreement_signed_at IS NULL',
  "contractor_agreement_version IS DISTINCT FROM '2026-07-13'",
  'code_of_conduct_agreed_at IS NULL',
  "COALESCE(v_profile.phone, '')",
  'is_available IS NOT TRUE',
  'tier IS NULL',
  "tier NOT IN ('starter', 'professional', 'elite', 'verified')",
  'application_fee_refunded IS TRUE',
  'application_decision_key IS NOT NULL',
  'account_closure_status',
]) {
  assert.ok(assignmentGuardSql.includes(readinessTruth), `Missing assignment readiness truth: ${readinessTruth}`);
}
assert.match(assignmentGuardSql, /owner_zero_dollar_simulation/);
assert.match(assignmentGuardSql, /v_readiness_guard_required := v_assignment_started/);
assert.match(assignmentGuardSql, /NEW\.assigned_at IS DISTINCT FROM OLD\.assigned_at/);
assert.match(assignmentGuardSql, /NEW\.assignment_token IS DISTINCT FROM OLD\.assignment_token/);
assert.match(migrationSource, /BEFORE INSERT OR UPDATE OF assembler_id, assembler_accepted_at, assigned_at,[\s\S]*assignment_token, status ON public\.bookings/);

const suspendSql = section(
  migrationSource,
  'CREATE OR REPLACE FUNCTION public.suspend_easer_if_no_active_jobs',
  'REVOKE ALL ON FUNCTION public.suspend_easer_if_no_active_jobs',
);
const profileLock = suspendSql.indexOf('FROM public.profiles');
const activeJobRead = suspendSql.indexOf('FROM public.bookings');
const suspensionUpdate = suspendSql.indexOf("SET status = 'suspended'");
assert.ok(profileLock > 0 && profileLock < activeJobRead && activeJobRead < suspensionUpdate);
assert.match(suspendSql.slice(profileLock, activeJobRead), /FOR UPDATE/);
assert.match(suspendSql, /status IN \('confirmed', 'en_route', 'arrived', 'in_progress'\)/);

const suspendRoute = section(updateSource, "if (action === 'suspend')", '// ── REINSTATE');
assert.match(suspendRoute, /rpc\('suspend_easer_if_no_active_jobs'/);
assert.doesNotMatch(suspendRoute, /\.from\('bookings'\)/);
assert.doesNotMatch(suspendRoute, /\.from\('profiles'\)\.update/);

for (const routeSource of [assignSource, acceptSource]) {
  assert.match(routeSource, /is\('financial_operation_key', null\)/);
  assert.match(routeSource, /is\('financial_operation_type', null\)/);
  assert.match(routeSource, /is\('financial_operation_started_at', null\)/);
}
assert.match(assignSource, /EASER_ASSIGNMENT_READINESS_CHANGED/);
assert.match(assignSource, /full_name, email, phone, status/);
assert.match(acceptSource, /EASER_ACCEPTANCE_READINESS_CHANGED/);
assert.match(acceptSource, /rpc\('accept_dispatch_offer'/);

console.log('Easer decision, assignment, and suspension concurrency checks passed.');
