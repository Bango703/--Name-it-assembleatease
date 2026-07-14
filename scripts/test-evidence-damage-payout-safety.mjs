import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildBookingFinancialSnapshot } from '../api/booking/_financial-operation.js';
import { verifyConnectPayoutReleaseState } from '../api/cron/release-payouts.js';

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  uploadSource,
  requestSource,
  payoutReviewSource,
  releaseSource,
  migrationSource,
  ownerSource,
] = await Promise.all([
  load('api/booking/upload-evidence.js'),
  load('api/owner/request-evidence.js'),
  load('api/booking/payout-review.js'),
  load('api/cron/release-payouts.js'),
  load('api/migrations/037_owner_easer_workflow_completion.sql'),
  load('owner/index.html'),
]);

assert.doesNotMatch(uploadSource, /['"]customer_confirmation['"]/);
assert.match(uploadSource, /record_booking_evidence/);
assert.match(uploadSource, /removeUploadedObject\(sb, storagePath\)/);
assert.doesNotMatch(uploadSource, /\.from\(['"]booking_evidence['"]\)\s*\.insert/);
assert.ok(
  uploadSource.indexOf('const workflowError = evidenceWorkflowError')
    < uploadSource.indexOf("Buffer.from(raw, 'base64')"),
  'assignment and workflow gates must run before base64 decode',
);
assert.ok(
  uploadSource.indexOf("Buffer.from(raw, 'base64')")
    < uploadSource.indexOf('.upload(storagePath, buf'),
  'validated bytes must precede storage writes',
);
assert.ok(
  uploadSource.indexOf('.upload(storagePath, buf')
    < uploadSource.indexOf("sb.rpc('record_booking_evidence'"),
  'storage must exist before its immutable database record is committed',
);

assert.match(requestSource, /rpc\(['"]request_booking_evidence_hold['"]/);
assert.doesNotMatch(requestSource, /\.update\(\{\s*evidence_requested_at/);
assert.match(payoutReviewSource, /resolve_damage_review/);
assert.match(payoutReviewSource, /rpc\(['"]resolve_booking_damage_review['"]/);
assert.match(ownerSource, /b\.damage_review_status === 'review_required'/);
assert.match(ownerSource, /data-action="damage-review"/);
assert.match(ownerSource, /decision: 'resolve_damage_review'/);
assert.match(ownerSource, /Resolving this review does not send money|it does not send an Easer payout/i);

const firstRecheck = releaseSource.indexOf('const postReservation = await verifyConnectPayoutReleaseState');
const finalRecheck = releaseSource.indexOf('const immediatelyBeforeTransfer = await verifyConnectPayoutReleaseState');
const stripeTransfer = releaseSource.indexOf('const transfer = await stripe.transfers.create');
assert.ok(firstRecheck > 0 && firstRecheck < finalRecheck && finalRecheck < stripeTransfer);
assert.match(releaseSource, /damage_review_status !== 'review_required'/);
assert.match(releaseSource, /post_request_completion_evidence_missing/);

const requestRpcStart = migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.request_booking_evidence_hold');
const requestRpcEnd = migrationSource.indexOf('REVOKE ALL ON FUNCTION public.request_booking_evidence_hold', requestRpcStart);
const requestRpc = migrationSource.slice(requestRpcStart, requestRpcEnd);
assert.match(requestRpc, /FOR UPDATE/);
assert.match(requestRpc, /payout_status IN \('paid', 'transferred'\)/);
assert.match(requestRpc, /stripe_transfer_id IS NOT NULL/);
assert.match(requestRpc, /financial_operation_key IS NOT NULL/);

const recordRpcStart = migrationSource.indexOf('CREATE OR REPLACE FUNCTION public.record_booking_evidence');
const recordRpcEnd = migrationSource.indexOf('REVOKE ALL ON FUNCTION public.record_booking_evidence', recordRpcStart);
const recordRpc = migrationSource.slice(recordRpcStart, recordRpcEnd);
assert.match(recordRpc, /FOR UPDATE/);
assert.match(recordRpc, /v_evidence_count >= 5/);
assert.match(recordRpc, /damage_review_status = 'review_required'/);
assert.match(recordRpc, /p_evidence_type NOT IN \('completion_photo', 'before_photo', 'damage_claim'\)/);
assert.match(migrationSource, /DROP POLICY IF EXISTS "easer_insert_own_booking_evidence"/);
assert.match(migrationSource, /v_booking\.damage_review_status = 'review_required'/);
assert.match(migrationSource, /booking_row\.damage_review_status = 'review_required'/);
assert.match(migrationSource, /GREATEST\(booking_row\.job_started_at, booking_row\.evidence_requested_at\)/);

const snapshot = buildBookingFinancialSnapshot({
  evidence_requested_at: '2026-07-14T10:00:00.000Z',
  job_started_at: '2026-07-14T09:00:00.000Z',
  damage_review_status: 'review_required',
  damage_claim_opened_at: '2026-07-14T09:30:00.000Z',
  payout_review_status: 'approved_full',
  payout_reviewed_at: '2026-07-14T09:45:00.000Z',
  payout_reviewed_by: 'owner',
  payout_review_notes: 'Reviewed canonical earnings.',
});
assert.equal(snapshot.damage_review_status, 'review_required');
assert.equal(snapshot.evidence_requested_at, '2026-07-14T10:00:00.000Z');
assert.equal(snapshot.payout_reviewed_by, 'owner');
for (const key of [
  'evidence_requested_at', 'job_started_at', 'damage_review_status',
  'damage_claim_opened_at', 'damage_reviewed_at', 'damage_reviewed_by',
  'damage_review_notes', 'payout_review_status', 'payout_reviewed_at',
  'payout_reviewed_by', 'payout_review_notes',
]) {
  assert.match(migrationSource, new RegExp(`'${key}', v_booking\\.${key}`));
}

const baseBooking = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  assembler_id: '22222222-2222-4222-8222-222222222222',
  assembler_due: 10_000,
  cancellation_easer_due_cents: 0,
  cancellation_easer_payout_status: null,
  payment_status: 'captured',
  payout_status: 'pending',
  payout_mode_snapshot: 'stripe_connect',
  payout_review_status: 'not_required',
  payout_reviewed_at: null,
  payout_reviewed_by: null,
  payout_review_notes: null,
  paid_out_at: null,
  stripe_transfer_id: null,
  evidence_requested_at: null,
  job_started_at: '2026-07-14T09:00:00.000Z',
  damage_review_status: 'not_required',
  damage_claim_opened_at: null,
  damage_reviewed_at: null,
  damage_reviewed_by: null,
  damage_review_notes: null,
  financial_operation_key: 'payout:connect:11111111-1111-4111-8111-111111111111',
  financial_operation_type: 'payout_connect',
  financial_operation_started_at: '2026-07-14T12:00:00.000Z',
};

function fakeReadSupabase(current, evidence = null) {
  const terminal = value => ({
    select() { return this; },
    eq() { return this; },
    gte() { return this; },
    order() { return this; },
    limit() { return this; },
    async maybeSingle() { return { data: value ? structuredClone(value) : null, error: null }; },
  });
  return {
    from(table) {
      if (table === 'bookings') return terminal(current);
      if (table === 'booking_evidence') return terminal(evidence);
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

const operationKey = baseBooking.financial_operation_key;
let state = await verifyConnectPayoutReleaseState(
  fakeReadSupabase({ ...baseBooking, damage_review_status: 'review_required', damage_claim_opened_at: '2026-07-14T10:00:00.000Z' }),
  baseBooking,
  operationKey,
  10_000,
);
assert.deepEqual({ ok: state.ok, reason: state.reason }, { ok: false, reason: 'damage_review_hold' });

state = await verifyConnectPayoutReleaseState(
  fakeReadSupabase({
    ...baseBooking,
    evidence_requested_at: '2026-07-14T11:00:00.000Z',
  }, {
    id: 'evidence-old',
    evidence_type: 'completion_photo',
    uploaded_by: baseBooking.assembler_id,
    created_at: '2026-07-14T10:00:00.000Z',
  }),
  baseBooking,
  operationKey,
  10_000,
);
assert.deepEqual({ ok: state.ok, reason: state.reason }, { ok: false, reason: 'post_request_completion_evidence_missing' });

state = await verifyConnectPayoutReleaseState(
  fakeReadSupabase({
    ...baseBooking,
    evidence_requested_at: '2026-07-14T11:00:00.000Z',
  }, {
    id: 'evidence-new',
    evidence_type: 'completion_photo',
    uploaded_by: baseBooking.assembler_id,
    created_at: '2026-07-14T11:30:00.000Z',
  }),
  baseBooking,
  operationKey,
  10_000,
);
assert.equal(state.ok, true);

console.log('Evidence, damage, and payout safety tests: PASS');
