import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  declineDispatchOffer,
  DISPATCH_HISTORY_EXCLUSION_STATUSES,
  finalizeDispatchRound,
  isLegacyAssignmentTokenFresh,
} from '../api/booking/_dispatch-safety.js';
import { bookingHasCurrentEaserFeeSnapshot, buildEaserFeeSnapshot } from '../api/booking/_easer-fee-snapshot.js';
import { isBookingPaymentReadyForDispatch } from '../api/_source-of-truth.js';

assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'authorized', stripe_payment_intent_id: 'pi_ready' }), true);
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'authorized' }), false, 'authorization without its linked PaymentIntent must fail closed');
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'deposit_paid', deposit_amount: 2_500, stripe_payment_intent_id: 'pi_deposit' }), true);
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'deposit_paid', deposit_amount: 0, stripe_payment_intent_id: 'pi_deposit' }), false);
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'pending' }), false);
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 10_000, payment_status: 'captured' }), false, 'early capture must require owner review before dispatch');
assert.equal(isBookingPaymentReadyForDispatch({ total_price: 0, payment_status: 'authorized', stripe_payment_intent_id: 'pi_zero' }), false);
assert.equal(isBookingPaymentReadyForDispatch({ total_price: -1, payment_status: 'authorized', stripe_payment_intent_id: 'pi_negative' }), false);
assert.equal(isBookingPaymentReadyForDispatch({
  total_price: 0,
  payment_status: 'not_required',
  confirmed_by: 'owner_zero_dollar_simulation',
}, { vercelEnv: 'preview' }), true);
assert.equal(isBookingPaymentReadyForDispatch({
  total_price: 0,
  payment_status: 'not_required',
  confirmed_by: 'owner_zero_dollar_simulation',
}, { vercelEnv: 'production' }), false, 'zero-dollar simulation must never dispatch in production');

const expectedHistoryStatuses = [
  'sent',
  'accepted',
  'declined',
  'expired',
  'cancelled',
  'superseded',
];
assert.deepEqual(
  [...new Set(DISPATCH_HISTORY_EXCLUSION_STATUSES)].sort(),
  expectedHistoryStatuses.sort(),
  'automatic redispatch must exclude every prior offer outcome',
);

const issuedAt = '2026-07-12T12:00:00.000Z';
const issuedAtMs = Date.parse(issuedAt);
assert.equal(isLegacyAssignmentTokenFresh(
  { assigned_at: issuedAt },
  { nowMs: issuedAtMs + (24 * 60 - 1) * 60_000, ttlMinutes: 24 * 60 },
), true, 'legacy assignment token should work just before its TTL');
assert.equal(isLegacyAssignmentTokenFresh(
  { assigned_at: issuedAt },
  { nowMs: issuedAtMs + 24 * 60 * 60_000, ttlMinutes: 24 * 60 },
), false, 'legacy assignment token must expire at its TTL');
assert.equal(isLegacyAssignmentTokenFresh({}, { nowMs: issuedAtMs }), false, 'missing issue time must fail closed');
assert.equal(isLegacyAssignmentTokenFresh(
  { assigned_at: issuedAt },
  { nowMs: issuedAtMs - 1, ttlMinutes: 24 * 60 },
), false, 'future-dated assignment token must fail closed');

const pricedBooking = {
  id: 'booking-priced',
  total_price: 10_000,
  tax_amount: 825,
  assemblecash_redeemed_cents: 2_000,
};
process.env.EASER_MEMBERSHIP_ENABLED = 'false';
const memberSnapshot = buildEaserFeeSnapshot(
  pricedBooking,
  { id: 'easer-member', has_membership: true },
  { snapshottedAt: issuedAt },
);
assert.deepEqual(memberSnapshot.updates, {
  easer_fee_snapshot_easer_id: 'easer-member',
  easer_fee_pct_snapshot: 30,
  easer_estimated_due_snapshot: 7_822,
  easer_fee_snapshot_at: issuedAt,
});
const nonMemberSnapshot = buildEaserFeeSnapshot(
  pricedBooking,
  { id: 'easer-standard', has_membership: false },
  { snapshottedAt: issuedAt },
);
assert.equal(nonMemberSnapshot.feePct, 30);
assert.equal(nonMemberSnapshot.estimatedDueCents, 7_822);
const disabledMembershipUnknown = buildEaserFeeSnapshot(
  pricedBooking,
  { id: 'easer-unknown', has_membership: null },
  { snapshottedAt: issuedAt },
);
assert.equal(disabledMembershipUnknown.feePct, 30, 'Launch mode must use the standard fee even when a dormant membership field is unknown');

process.env.EASER_MEMBERSHIP_ENABLED = 'true';
const futureMemberSnapshot = buildEaserFeeSnapshot(
  pricedBooking,
  { id: 'future-member', has_membership: true },
  { snapshottedAt: issuedAt },
);
assert.equal(futureMemberSnapshot.feePct, 25, 'The dormant member tier must remain testable behind its explicit flag');
assert.equal(futureMemberSnapshot.estimatedDueCents, 8_381);
assert.throws(
  () => buildEaserFeeSnapshot(pricedBooking, { id: 'future-unknown', has_membership: null }),
  error => error?.code === 'EASER_FEE_SNAPSHOT_PROFILE_FAILED',
  'Enabled membership mode must fail closed when membership truth is unknown',
);
process.env.EASER_MEMBERSHIP_ENABLED = 'false';
assert.equal(bookingHasCurrentEaserFeeSnapshot({
  assembler_id: 'easer-member',
  ...memberSnapshot.updates,
}), true);
assert.equal(bookingHasCurrentEaserFeeSnapshot({
  assembler_id: 'easer-member',
  ...memberSnapshot.updates,
  easer_fee_snapshot_at: null,
}), false, 'a partial snapshot must be rebuilt before money logic uses it');

const rpcCalls = [];
const fakeSb = {
  rpc: async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'decline_dispatch_offer') {
      return { data: [{ result_action: 'manual_required', result_ref: 'AAE-25', result_attempt: 3 }], error: null };
    }
    return { data: [{ result_action: 'open_offers', result_ref: 'AAE-25', result_attempt: 3 }], error: null };
  },
};
const finalDecline = await declineDispatchOffer(fakeSb, {
  offerId: 'offer-1',
  bookingId: 'booking-1',
  easerId: 'easer-1',
  reason: 'unavailable',
  declinedAt: issuedAt,
  maxAttempts: 3,
});
assert.deepEqual(finalDecline, { action: 'manual_required', ref: 'AAE-25', attempt: 3 });
assert.equal(rpcCalls[0].name, 'decline_dispatch_offer');
assert.equal(rpcCalls[0].args.p_max_attempts, 3);
const openRound = await finalizeDispatchRound(fakeSb, { bookingId: 'booking-1', maxAttempts: 3 });
assert.deepEqual(openRound, { action: 'open_offers', ref: 'AAE-25', attempt: 3 });

const [
  acceptSource,
  assignSource,
  declineSource,
  dropSource,
  dispatchSource,
  dispatchEndpointSource,
  dispatchControlSource,
  autoDispatchSource,
  easerStatusSource,
  expireSource,
  migrationSource,
  workflowMigrationSource,
  migrationSource040,
] = await Promise.all([
  readFile(new URL('../api/booking/accept-dispatch.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/assign.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/decline-dispatch.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/drop-job.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/_dispatch-internal.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/dispatch.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/dispatch-control.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/cron/auto-dispatch.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/booking/easer-status.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/cron/expire-offers.js', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/036_dispatch_state_safety.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/037_owner_easer_workflow_completion.sql', import.meta.url), 'utf8'),
  readFile(new URL('../api/migrations/040_owner_manual_easer_record_link.sql', import.meta.url), 'utf8'),
]);

const compact = (value) => value.replace(/\s+/g, ' ');
const acceptCompact = compact(acceptSource);
const assignCompact = compact(assignSource);
const declineCompact = compact(declineSource);
const dropCompact = compact(dropSource);
const dispatchCompact = compact(dispatchSource);
const dispatchEndpointCompact = compact(dispatchEndpointSource);
const dispatchControlCompact = compact(dispatchControlSource);
const expireCompact = compact(expireSource);
const migrationCompact = compact(migrationSource);
const workflowMigrationCompact = compact(workflowMigrationSource);

// Cancelled-accept race: the endpoint delegates the final transition to one
// database transaction, which locks both records and requires the exact live
// confirmed/unassigned attempt before changing either source of truth.
assert.ok(acceptSource.includes("sb.rpc('accept_dispatch_offer'"), 'acceptance must use the atomic RPC');
assert.ok(migrationSource.includes('CREATE OR REPLACE FUNCTION public.accept_dispatch_offer'));
assert.ok((migrationSource.match(/FOR UPDATE/g) || []).length >= 3, 'dispatch finalization and acceptance must row-lock state');
assert.ok(migrationCompact.includes("v_booking.status <> 'confirmed' OR v_booking.assembler_id IS NOT NULL"));
assert.ok(migrationCompact.includes('COALESCE(v_booking.dispatch_attempt, 0) <> p_expected_attempt'));
assert.ok(migrationCompact.includes('COALESCE(v_booking.dispatch_paused, FALSE)'));
assert.ok(migrationCompact.includes('COALESCE(v_booking.needs_manual_dispatch, FALSE)'));
assert.ok(migrationCompact.includes("SET offer_status = 'accepted'"));
assert.ok(migrationCompact.includes('SET assembler_id = p_easer_id'));
assert.ok(migrationCompact.includes("SET offer_status = 'superseded'"));

// Assignment economics are written in the same CAS as the assignee, using a
// successfully loaded membership value and the canonical snapshot calculator.
for (const field of [
  'easer_fee_snapshot_easer_id',
  'easer_fee_pct_snapshot',
  'easer_estimated_due_snapshot',
  'easer_fee_snapshot_at',
]) {
  assert.ok(migrationSource.includes(field), `atomic accept RPC must write ${field}`);
}
assert.ok(acceptSource.includes('buildEaserFeeSnapshot(booking, easer'));
assert.ok(assignSource.includes('buildEaserFeeSnapshot(booking, assembler'));
assert.ok((acceptSource.match(/isBookingPaymentReadyForDispatch\(booking\)/g) || []).length >= 2, 'both offer and legacy acceptance paths must preflight payment truth');
// Assignment still fails closed on payment truth. The ONLY exemption is a
// record-only link onto an already-completed owner-manual (offline) job, which
// implies no dispatch and no Stripe money. Lock that bypass to exactly that
// shape so it can never silently widen to live or online bookings.
assert.ok(assignSource.includes('!recordOnlyOwnerManualCompleted && !isBookingPaymentReadyForDispatch(booking)'));
assert.match(
  assignSource,
  /recordOnlyOwnerManualCompleted = booking\.source === 'owner_manual' && booking\.status === BOOKING_STATUS\.COMPLETED/,
  'the assignment payment bypass must require BOTH owner_manual source and completed status',
);
assert.match(
  migrationSource040,
  /v_record_only_owner_manual := COALESCE\(NEW\.source, 'online'\) = 'owner_manual'[\s\S]*AND NEW\.status = 'completed'/,
  'migration 040 must scope the trigger bypass to completed owner-manual bookings only',
);
assert.match(
  migrationSource040,
  /RAISE EXCEPTION 'Customer payment must be verified before assignment or acceptance'/,
  'migration 040 must keep the payment guard for every non-record-only assignment',
);
assert.ok(assignCompact.includes(".eq('payment_status', booking.payment_status)"));
assert.ok(acceptCompact.includes(".eq('payment_status', booking.payment_status)"));
assert.ok(acceptSource.includes('p_easer_fee_pct_snapshot: feeSnapshot.feePct'));
assert.ok(acceptSource.includes('p_easer_estimated_due_snapshot: feeSnapshot.estimatedDueCents'));
assert.ok(acceptSource.includes('p_easer_fee_snapshot_at: feeSnapshot.snapshottedAt'));
assert.ok(migrationSource.includes('p_easer_fee_pct_snapshot INTEGER'));
assert.ok(migrationSource.includes('p_easer_estimated_due_snapshot INTEGER'));
assert.ok(migrationSource.includes('p_easer_fee_snapshot_at TIMESTAMPTZ'));
assert.ok(acceptCompact.includes('...feeSnapshot.updates'));
assert.ok(assignCompact.includes('...feeSnapshot.updates'));
assert.ok(assignSource.includes('const estimatedPayCents = feeSnapshot.estimatedDueCents'));
assert.ok(acceptSource.includes('Easer membership status could not be verified. The job was not accepted.'));
assert.ok(assignSource.includes('Easer membership status could not be verified. Assignment was not changed.'));

// A reserved completion/cancellation/payout operation owns the booking until
// it releases its key; no assignment or acceptance path may cross that lock.
assert.ok(migrationCompact.includes('v_booking.financial_operation_key IS NOT NULL'));
assert.ok(migrationCompact.includes("RETURN QUERY SELECT 'financial_operation'::TEXT"));
assert.ok(migrationCompact.includes('AND financial_operation_key IS NULL'));
assert.ok(acceptCompact.includes(".is('financial_operation_key', null)"));
assert.ok(assignCompact.includes(".is('financial_operation_key', null)"));
assert.ok(dispatchSource.includes('if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at)'));
assert.ok(dispatchSource.includes('if (!isBookingPaymentReadyForDispatch(booking))'));
assert.ok(dispatchSource.includes("code: 'DISPATCH_PAYMENT_NOT_VERIFIED'"));
assert.ok(dispatchCompact.includes(".is('financial_operation_key', null)"));
assert.ok(acceptSource.includes('if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at)'));
assert.ok(assignSource.includes('if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at)'));
assert.ok(migrationSource.includes("VALUES (36, 'dispatch_state_safety')"));
assert.ok(workflowMigrationSource.includes('Customer payment must be verified before assignment or acceptance'));
assert.ok(workflowMigrationCompact.includes('BEFORE INSERT OR UPDATE OF assembler_id, assembler_accepted_at, status ON public.bookings'));
assert.ok(workflowMigrationSource.includes("NEW.payment_status = 'authorized'"));
assert.ok(workflowMigrationSource.includes("NEW.payment_status = 'deposit_paid'"));
assert.ok(workflowMigrationSource.includes("COALESCE(NEW.total_price, 0) < 0"));
assert.ok(workflowMigrationSource.includes("NEW.status IN ('confirmed', 'en_route', 'arrived', 'in_progress')"));

// Owner assignment must lose cleanly if cancellation/acceptance/reassignment
// changed the exact booking snapshot after the owner loaded it.
// An Easer credited with a finished offline job must be paid the canonical
// split, never $0, and sales tax must never enter the payout base.
assert.match(
  assignSource,
  /computeBookingSplitFromSnapshot\(\{[\s\S]{0,240}?taxCents: booking\.tax_amount \|\| 0,[\s\S]{0,120}?feePct: feeSnapshot\.feePct/,
  'the record-only link must derive earnings from the canonical snapshot split with tax excluded',
);
assert.ok(assignCompact.includes('assembler_due: split.assemblerDueCents'), 'a linked Easer must be credited the canonical amount due');
assert.ok(assignCompact.includes('platform_fee: split.platformFeeCents'), 'the platform fee must come from the same canonical split');
assert.ok(assignCompact.includes("payout_status: split.assemblerDueCents > 0 ? 'pending' : null"), 'earned money must open a payout owed');
assert.ok(assignCompact.includes("isStripeConnectEnabled() ? 'stripe_connect' : 'manual'"), 'the linked earnings must snapshot the active payout rail');
assert.ok(assignCompact.includes("payout_review_status: 'not_required'"), 'new linked earnings must start with no payout review hold');
assert.ok(!/assembler_due:\s*0\b/.test(assignCompact), 'an assigned Easer must never be recorded as earning zero');

// The status is pinned on both branches. A record-only owner-manual link may
// only land on an already-COMPLETED offline job; every other assignment still
// requires CONFIRMED, so a live booking can never be assigned off a stale read.
assert.ok(assignCompact.includes(".eq('status', recordOnlyOwnerManualCompleted ? BOOKING_STATUS.COMPLETED : BOOKING_STATUS.CONFIRMED)"));
// The money snapshot (payment status, price, PaymentIntents) is only released
// from the CAS for the record-only owner-manual link, where no Stripe money
// exists to race against. Every real assignment still pins it.
const assignMoneyCas = assignCompact.slice(
  assignCompact.indexOf('if (!recordOnlyOwnerManualCompleted) { updateQuery = updateQuery.eq('),
  assignCompact.indexOf('if (reassign && booking.assembler_id)'),
);
assert.ok(assignMoneyCas.length > 0, 'the assignment money CAS block must remain scoped to non-record-only assignments');
for (const moneyColumn of ['payment_status', 'total_price', 'stripe_payment_intent_id', 'stripe_deposit_intent_id']) {
  assert.ok(assignMoneyCas.includes(`'${moneyColumn}'`), `assignment must CAS ${moneyColumn} on every real assignment`);
}
assert.ok(assignCompact.includes("updateQuery.eq('assembler_id', booking.assembler_id)"));
assert.ok(assignCompact.includes("updateQuery.eq('assigned_at', booking.assigned_at)"));
assert.ok(assignCompact.includes("updateQuery.is('assembler_id', null)"));
assert.ok(assignCompact.indexOf("updateQuery.select('id, assembler_id')") < assignCompact.indexOf(".eq('offer_status', DISPATCH_OFFER_STATUS.SENT)"), 'open offers may be cancelled only after assignment CAS succeeds');

// Decline must be a sent->declined row-locked transaction, handle errors and
// synchronously resolve the final offer instead of relying on fire-and-forget.
assert.ok(declineSource.includes('declineResolution = await declineDispatchOffer'));
assert.ok(migrationSource.includes('CREATE OR REPLACE FUNCTION public.decline_dispatch_offer'));
assert.ok(migrationCompact.includes("IF v_offer.offer_status <> 'sent' THEN"));
assert.ok(migrationCompact.includes('IF v_offer.expires_at <= p_declined_at THEN'));
assert.ok(migrationCompact.includes("SET offer_status = 'declined'"));
assert.ok(migrationCompact.includes('FROM public.finalize_dispatch_round(p_booking_id, p_max_attempts, FALSE)'));
assert.ok(declineSource.includes('catch (declineError)'));
assert.ok(declineSource.includes('const retry = await dispatchBooking(bookingId)'));
assert.equal(declineSource.includes('dispatchBooking(bookingId).catch'), false);

// The final all-declined/all-expired attempt atomically pauses dispatch, marks
// owner action, and uses the shared awaited alert/audit path.
assert.ok(migrationCompact.includes('IF NOT p_force_manual AND v_attempt < p_max_attempts THEN'));
assert.ok(migrationCompact.includes("SET needs_manual_dispatch = TRUE, dispatch_paused = TRUE, dispatch_status = 'manual_required'"));
assert.ok(migrationCompact.includes("INSERT INTO public.activity_logs ( booking_id, event_type"));
assert.ok(migrationCompact.includes("'dispatch_manual_required'"));
assert.ok(declineSource.includes('await notifyOwnerManualDispatch'));
assert.ok(expireSource.includes('await notifyOwnerManualDispatch'));
assert.ok(expireSource.includes('await holdDispatchForPaymentReconciliation'));
assert.ok(expireCompact.includes("retry?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED'"));
assert.ok(expireCompact.includes('forceManual: true'));
assert.ok(expireSource.includes('recoveryBookings'), 'cron must recover a round resolved before redispatch started');
assert.ok(expireCompact.includes(".in('dispatch_status', ['offered', 'dropped'])"));

// Dropping an accepted job cannot report successful redispatch before the
// dispatch result is known; no-offer/error outcomes are forced to owner action.
assert.ok(dropSource.includes('redispatch = await dispatchBooking'));
assert.equal(dropSource.includes('dispatchBooking(bookingId, { excludeEaserId: user.id })\n    .catch'), false);
assert.ok(dropCompact.includes('forceManual: true'));
assert.ok(dropSource.includes("redispatch?.code === 'DISPATCH_PAYMENT_NOT_VERIFIED'"));
assert.ok(dropSource.includes('await holdDispatchForPaymentReconciliation'));
assert.ok(dropCompact.includes("finalization.action === 'manual_required'"));
assert.ok(dropSource.includes('if (booking.financial_operation_key)'));
assert.ok(dropCompact.includes(".is('financial_operation_key', null)"));
assert.ok(dropSource.includes('easer_fee_snapshot_easer_id: null'));

// Competing dispatch rounds use exact attempt-state CAS plus a database guard
// against duplicate simultaneously active offers.
assert.ok(dispatchCompact.includes("bookingUpdateQuery.eq('dispatch_attempt', booking.dispatch_attempt)"));
assert.ok(dispatchCompact.includes(".eq('payment_status', booking.payment_status)"));
assert.ok(dispatchCompact.includes("bookingUpdateQuery.eq('total_price', booking.total_price)"));
assert.ok(dispatchCompact.includes("bookingUpdateQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id)"));
assert.ok(dispatchEndpointSource.includes('if (!isBookingPaymentReadyForDispatch(booking))'));
assert.ok(dispatchEndpointCompact.indexOf('if (!isBookingPaymentReadyForDispatch(booking))') < dispatchEndpointCompact.indexOf('let forceQuery = sb.from'), 'force dispatch must verify payment before clearing flags/offers');
assert.ok(dispatchEndpointCompact.indexOf(".eq('payment_status', booking.payment_status)") < dispatchEndpointCompact.indexOf('const { error: cancelOfferError }'), 'force dispatch must win a payment snapshot CAS before cancelling offers');
assert.ok(dispatchControlSource.includes('const paymentHoldResponse'));
assert.ok((dispatchControlSource.match(/isBookingPaymentReadyForDispatch\(booking\)/g) || []).length >= 3, 'unpause, dry-run, and retry must enforce payment truth');
assert.ok(dispatchControlCompact.indexOf('if (!isBookingPaymentReadyForDispatch(booking)) return paymentHoldResponse();') < dispatchControlCompact.indexOf('let retryQuery = sb.from'), 'retry must verify payment before mutating state');
assert.ok(dispatchControlCompact.indexOf(".eq('payment_status', booking.payment_status)") < dispatchControlCompact.indexOf('const { error: retryOfferError }'), 'retry must win a payment snapshot CAS before cancelling offers');
assert.ok(autoDispatchSource.includes(".in('payment_status', DISPATCH_PAYMENT_STATUSES)"));
assert.ok(autoDispatchSource.includes('filter(isBookingPaymentReadyForDispatch)'));
assert.ok(declineSource.includes('await holdDispatchForPaymentReconciliation'));
assert.ok(declineSource.includes("retry?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED'"));
assert.ok(easerStatusSource.includes('if (!isBookingPaymentReadyForDispatch(booking))'));
assert.ok(easerStatusSource.includes(".eq('payment_status', booking.payment_status)"));
assert.ok(dispatchSource.includes('DISPATCH_HISTORY_EXCLUSION_STATUSES'));
assert.ok(migrationCompact.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_dispatch_offers_active_booking_easer'));
assert.ok(migrationCompact.includes("WHERE offer_status = 'sent'"));

// Legacy owner-assignment links are bounded and still CAS the current token.
assert.ok(acceptSource.includes('isLegacyAssignmentTokenFresh(booking)'));
assert.ok(acceptCompact.includes(".eq('assembler_id', assemblerId).eq('assignment_token', token).select('id')"));

console.log('dispatch safety tests: PASS');
