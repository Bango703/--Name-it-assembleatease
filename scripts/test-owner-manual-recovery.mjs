import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [
  migration,
  paymentGuardMigration,
  completionApi,
  resolutionApi,
  paymentApi,
  evidenceApi,
  assemblersApi,
  liveOpsApi,
  opsAlertApi,
  ownerUi,
] = await Promise.all([
  readFile(new URL('../api/migrations/047_owner_manual_recovery_and_evidence.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/049_owner_manual_gross_payment_guard.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/complete.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/resolve-return-visit.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/record-manual-payment.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/upload-completion-evidence.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/assemblers.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/owner/live-ops.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/cron/ops-alert.js', import.meta.url), 'utf8'),
  readFile(new URL('../owner/index.html', import.meta.url), 'utf8'),
]);

assert.match(migration, /guard_booking_return_visit_completion/);
assert.match(migration, /A booking cannot be completed while a return visit remains open/);
assert.match(migration, /BEFORE INSERT OR UPDATE OF status, return_visit_required/);
assert.match(migration, /record_owner_manual_payment_event_v3/);
assert.match(migration, /v_booking\.assembler_id IS NOT NULL/);
assert.match(migration, /COALESCE\(v_booking\.payout_status, 'unpaid'\) <> 'unpaid'/);
assert.match(paymentGuardMigration, /record_owner_manual_payment_event_v4/);
assert.match(paymentGuardMigration, /v_gross \+ p_amount_cents > v_target_total/);
assert.match(paymentGuardMigration, /Refunds remain visible financial adjustments and never recreate balance due/);
assert.match(paymentGuardMigration, /record_owner_manual_payment_event_v3/);
assert.match(migration, /record_owner_manual_payment_event_v2/);
assert.match(migration, /UPDATE public\.owner_manual_payment_events[\s\S]*discount_cents = v_discount/);
assert.match(migration, /record_owner_manual_completion_evidence/);
assert.match(migration, /is_owner IS TRUE/);
assert.match(migration, /Maximum 5 evidence files per booking/);

assert.match(completionApi, /booking\.return_visit_required === true/);
assert.match(completionApi, /RETURN_VISIT_OPEN/);
assert.match(completionApi, /RETURN_VISIT_STATE_CONFLICT/);
const ownerCompletion = completionApi.slice(completionApi.indexOf('async function completeOwnerManualBooking'));
assert.doesNotMatch(ownerCompletion, /amount_charged: totalCents/);

assert.match(resolutionApi, /if \(!verifyOwner\(req\)\)/);
assert.match(resolutionApi, /\['complete', 'reopen'\]/);
assert.match(resolutionApi, /financial_reconciliation_required_at/);
assert.match(resolutionApi, /return_visit_required: false/);
assert.match(resolutionApi, /return_visit_completed_at: now/);
assert.match(resolutionApi, /status: 'confirmed'/);
assert.match(resolutionApi, /notificationDelivered/);

assert.match(paymentApi, /record_owner_manual_payment_event_v4/);
assert.match(paymentApi, /notificationType: 'payment_receipt'/);
assert.match(paymentApi, /Remaining balance/);
assert.match(paymentApi, /This receipt confirms payment only/);

assert.match(evidenceApi, /if \(!verifyOwner\(req\)\)/);
assert.match(evidenceApi, /record_owner_manual_completion_evidence/);
assert.match(evidenceApi, /matchesMagic/);
assert.match(evidenceApi, /cleanupStorage/);
assert.match(assemblersApi, /ownerEaser/);
assert.doesNotMatch(assemblersApi, /\.eq\('identity_verified', true\)/);

assert.match(liveOpsApi, /status\.neq\.completed,return_visit_required\.eq\.true/);
assert.match(liveOpsApi, /booking\.status !== 'completed' \|\| booking\.return_visit_required === true/);
assert.match(opsAlertApi, /and\(status\.eq\.completed,return_visit_required\.eq\.true\)/);

assert.match(ownerUi, /Complete Return Visit &amp; Job/);
assert.match(ownerUi, /Reopen Unfinished Job/);
assert.match(ownerUi, /Record Customer Payment/);
assert.match(ownerUi, /Record Cash \/ Bank Payment/);
assert.match(ownerUi, /No customer payment recorded in AAE/);
assert.match(ownerUi, /Original Customer Total/);
assert.match(ownerUi, /Documented Discount/);
assert.match(ownerUi, /Credit Owner-Easer/);
assert.match(ownerUi, /upload-completion-evidence/);
assert.match(ownerUi, /detail-dispatch-tab/);
assert.match(ownerUi, /customer email needs follow-up/);

console.log('Owner-manual recovery and usability safety checks passed.');
