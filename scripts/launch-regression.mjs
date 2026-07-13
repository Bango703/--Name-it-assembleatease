import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeBookingFinancialSummary,
  computeBookingSplitFromSnapshot,
  computeCancellationFee,
} from '../api/_source-of-truth.js';
import { getEaserReadiness } from '../api/_easer-readiness.js';
import { CONTRACTOR_AGREEMENT_VERSION } from '../api/_assembler-onboarding.js';
import { canTransitionBookingStatus } from '../api/booking/_workflow-engine.js';
import { redactAssignmentCustomerData } from '../api/booking/my-assignments.js';
import {
  deriveGuestMutationToken,
  guestMutationTokenHash,
  safeTokenHashMatch,
} from '../api/_payment-security.js';

function source(file) {
  return readFileSync(file, 'utf8');
}

// Financial truth: tax is excluded from the payout basis; platform-funded
// AssembleCash is added back so the Easer is not underpaid.
const split = computeBookingSplitFromSnapshot({
  amountChargedCents: 14_000,
  taxCents: 1_000,
  assemblecashRedeemedCents: 2_000,
  isMember: false,
});
assert.deepEqual(split, {
  totalCents: 14_000,
  taxCents: 1_000,
  pretaxCollectedCents: 13_000,
  payoutBaseCents: 15_000,
  feePct: 30,
  protectedPlatformFeeCents: 4_500,
  platformFeeCents: 2_500,
  assemblerDueCents: 10_500,
  assemblecashRedeemedCents: 2_000,
});

const summary = computeBookingFinancialSummary({
  amountChargedCents: 10_825,
  refundAmountCents: 5_412,
  taxAmountCents: 825,
  stripeFeeCents: 344,
  assemblerDueCents: 7_000,
});
assert.equal(summary.netChargedCents, 5_413);
assert.equal(summary.taxCollectedCents, 413);
assert.equal(summary.processingFeeIsActual, true);
assert.equal(summary.platformGrossCents, -2_344, 'Refunded jobs must retain the Easer liability instead of hiding a loss');

assert.deepEqual(
  computeCancellationFee({ serviceSubtotalCents: 20_000, hoursUntilAppointment: 30 }),
  { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false },
);
assert.equal(computeCancellationFee({ serviceSubtotalCents: 20_000, hoursUntilAppointment: 8 }).feeCents, 2_000);
assert.equal(computeCancellationFee({ serviceSubtotalCents: 20_000, status: 'en_route' }).feeCents, 3_000);

const readyProfile = {
  application_status: 'approved',
  contractor_agreement_signed_at: '2026-07-12T12:00:00.000Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  code_of_conduct_agreed_at: '2026-07-12T12:00:00.000Z',
  identity_verified: true,
  status: 'active',
  tier: 'starter',
  is_available: true,
  phone: '+1 737 555 0100',
};
const manualReady = await getEaserReadiness(readyProfile, { connectRequired: false });
assert.equal(manualReady.isReady, true, 'Manual payout launch must not require Stripe Connect');
const staleAgreement = await getEaserReadiness({ ...readyProfile, contractor_agreement_version: 'old' }, { connectRequired: false });
assert.equal(staleAgreement.isReady, false);
assert.match(staleAgreement.missingItems.join(' '), /current contractor agreement/i);
const connectBlocked = await getEaserReadiness(readyProfile, { connectRequired: true, stripeAccount: null });
assert.equal(connectBlocked.isReady, false, 'Connect mode must fail closed without verified live account state');

assert.equal(canTransitionBookingStatus('confirmed', 'en_route'), true);
assert.equal(canTransitionBookingStatus('confirmed', 'arrived'), false);
assert.equal(canTransitionBookingStatus('arrived', 'completed'), false);
assert.equal(canTransitionBookingStatus('in_progress', 'completed'), true);

const [unaccepted, terminal] = redactAssignmentCustomerData([
  { status: 'confirmed', assembler_accepted_at: null, customer_name: 'Private', customer_email: 'private@example.com', customer_phone: '1', address: 'Private', details: 'Private', assignment_token: 'a' },
  { status: 'completed', assembler_accepted_at: '2026-07-12', customer_name: 'Private', customer_email: 'private@example.com', customer_phone: '1', address: 'Private', details: 'Private', assignment_token: 'b' },
]);
assert.equal(unaccepted.customer_email, null);
assert.equal(terminal.customer_email, null);
assert.equal(terminal.assignment_token, null);

process.env.GUEST_ACCESS_TOKEN_SECRET = 'g'.repeat(48);
const guestBooking = { id: '00000000-0000-4000-8000-000000000001', ref: 'AAE-TEST1234', customer_email: 'customer@example.com' };
const guestToken = deriveGuestMutationToken({ bookingId: guestBooking.id, ref: guestBooking.ref, email: guestBooking.customer_email });
const guestHash = guestMutationTokenHash(guestBooking);
assert.equal(safeTokenHashMatch(guestToken, guestHash), true);
assert.equal(safeTokenHashMatch(guestToken + 'x', guestHash), false);

process.env.OWNER_SESSION_SECRET = 's'.repeat(48);
process.env.OWNER_PASSWORD = 'owner-password-long-enough-for-local-test';
process.env.VERCEL_ENV = 'production';
const { createOwnerSessionToken, verifyOwner } = await import('../api/_email.js');
const session = createOwnerSessionToken();
assert.ok(session?.token);
assert.equal(verifyOwner({ headers: { authorization: `Bearer ${session.token}` } }), true);
assert.equal(verifyOwner({ headers: { 'x-owner-password': process.env.OWNER_PASSWORD }, body: {} }), false, 'Production password headers must be disabled');

// Static launch guards catch route regressions that otherwise look harmless in
// isolated unit tests.
const legacyAccept = source('api/booking/accept.js');
assert.doesNotMatch(legacyAccept, /\.from\(['"]bookings['"]\)|\.update\(/, 'Legacy GET assignment route must never mutate state');
assert.match(legacyAccept, /status\(410\)/);

const trackApi = source('api/booking/track.js');
assert.match(trackApi, /safeTokenHashMatch/);
assert.match(trackApi, /email, ref, token/);

const ownerPage = source('owner/index.html');
assert.doesNotMatch(ownerPage, /x-owner-password|owner_pw|bulk-delete-btn/);
assert.match(ownerPage, /Authorization': 'Bearer/);
assert.match(ownerPage, /Quote sent for customer approval/);
assert.doesNotMatch(ownerPage, /Card authorized & booking confirmed|Finalize Quote & Authorize Card/);

const browserApi = source('assets/js/api.js');
assert.doesNotMatch(browserApi, /\.from\(['"]bookings['"]\)/, 'Browser code must not query the bookings base table');

const migration31 = source('api/migrations/031_security_privilege_hardening.sql');
assert.match(migration31, /DROP POLICY IF EXISTS "users_can_update_own_profile"/);
assert.match(migration31, /update_own_easer_profile/);
const migration32 = source('api/migrations/032_payment_truth_and_customer_consent.sql');
assert.match(migration32, /quote_approved_at/);
assert.match(migration32, /stripe_bank_payout_status/);
const migration33 = source('api/migrations/033_launch_compliance_and_schema_state.sql');
assert.match(migration33, /REVOKE ALL ON TABLE public\.bookings FROM PUBLIC, anon, authenticated/);
assert.match(migration33, /platform_schema_state/);
assert.match(migration33, /easer_compliance_events/);

for (const file of ['api/booking/complete.js', 'api/booking/assembler-complete.js']) {
  const text = source(file);
  assert.match(text, /assembler_accepted_at/);
  assert.match(text, /CAPTURE_FAILED|capture failed/i);
}

console.log('Launch regression checks passed');
