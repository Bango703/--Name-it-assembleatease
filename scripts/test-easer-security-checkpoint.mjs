import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildIdentityResumeUrl,
  CONTRACTOR_AGREEMENT_VERSION,
  ensureIdentityResumeToken,
  IDENTITY_RESUME_TOKEN_TTL_MS,
  isIdentityResumeTokenValid,
  recordAgreementAcceptance,
  rotateIdentityResumeToken,
  updateProfileRequired,
} from '../api/_assembler-onboarding.js';
import { isActiveApprovedEaserProfile, requireActiveApprovedEaser } from '../api/_easer-access.js';
import {
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_CURRENCY,
  getEaserApplicationFeeStatus,
} from '../api/_easer-application-fee.js';
import { getEaserReadiness, isApplicationFeeSatisfied } from '../api/_easer-readiness.js';
import { deriveOfferLocation } from '../api/booking/my-assignments.js';

const now = Date.now();
const validTokenProfile = {
  identity_resume_token: 'a'.repeat(96),
  identity_resume_token_expires_at: new Date(now + 60_000).toISOString(),
};
assert.equal(isIdentityResumeTokenValid(validTokenProfile, now), true);
assert.equal(isIdentityResumeTokenValid({ ...validTokenProfile, identity_resume_token_expires_at: new Date(now).toISOString() }, now), false);
assert.equal(isIdentityResumeTokenValid({ identity_resume_token: 'legacy-without-expiry' }, now), false);
assert.ok(IDENTITY_RESUME_TOKEN_TTL_MS >= 60 * 60 * 1000);
assert.ok(IDENTITY_RESUME_TOKEN_TTL_MS <= 7 * 24 * 60 * 60 * 1000);
assert.match(buildIdentityResumeUrl('safe_token'), /token=safe_token$/);
assert.throws(() => buildIdentityResumeUrl(''), /required/);

function profileUpdateMock(result) {
  const state = { updates: null, profileId: null, calls: 0, filters: [] };
  const chain = {
    update(updates) { state.updates = updates; return chain; },
    eq(field, value) {
      state.filters.push({ operator: 'eq', field, value });
      if (field === 'id') state.profileId = value;
      return chain;
    },
    gt(field, value) { state.filters.push({ operator: 'gt', field, value }); return chain; },
    select(value) { assert.equal(value, 'id'); return chain; },
    async maybeSingle() { state.calls += 1; return result; },
  };
  return { sb: { from(table) { assert.equal(table, 'profiles'); return chain; } }, state };
}
{
  const { sb, state } = profileUpdateMock({ data: { id: 'profile-1' }, error: null });
  const agreement = await recordAgreementAcceptance(sb, {
    profileId: 'profile-1',
    signedName: 'Test Easer',
    agreementIp: '127.0.0.1',
    agreementUserAgent: 'test-agent',
    rotateResumeToken: true,
    expectedResumeToken: 'old-token',
  });
  assert.match(agreement.resumeToken, /^[a-f0-9]{96}$/);
  assert.equal(state.updates.identity_resume_token, agreement.resumeToken);
  assert.ok(state.filters.some(filter => filter.field === 'identity_resume_token' && filter.value === 'old-token'));
  assert.ok(state.filters.some(filter => filter.operator === 'gt' && filter.field === 'identity_resume_token_expires_at'));
}
{
  const { sb } = profileUpdateMock({ data: null, error: null });
  await assert.rejects(recordAgreementAcceptance(sb, {
    profileId: 'profile-1',
    signedName: 'Test Easer',
    agreementIp: '127.0.0.1',
    agreementUserAgent: 'test-agent',
    rotateResumeToken: true,
    expectedResumeToken: 'replayed-token',
  }), /already used or expired/);
}

{
  const { sb } = profileUpdateMock({ data: null, error: { message: 'database unavailable' } });
  await assert.rejects(updateProfileRequired(sb, 'profile-1', { identity_verified: true }, 'test truth'), /database unavailable/);
}
{
  const { sb } = profileUpdateMock({ data: null, error: null });
  await assert.rejects(updateProfileRequired(sb, 'profile-1', { identity_verified: true }, 'test truth'), /profile not found/i);
}
{
  const { sb, state } = profileUpdateMock({ data: { id: 'profile-1' }, error: null });
  await recordAgreementAcceptance(sb, {
    profileId: 'profile-1',
    signedName: 'Test Easer',
    agreementIp: '127.0.0.1',
    agreementUserAgent: 'test-agent',
  });
  assert.equal(state.updates.contractor_agreement_version, CONTRACTOR_AGREEMENT_VERSION);
  assert.equal(state.updates.contractor_agreement_signed_name, 'Test Easer');
}
{
  const { sb, state } = profileUpdateMock({ data: { id: 'profile-1' }, error: null });
  const rotated = await rotateIdentityResumeToken(sb, 'profile-1');
  assert.match(rotated, /^[a-f0-9]{96}$/);
  assert.equal(state.updates.identity_resume_token, rotated);
  assert.ok(Date.parse(state.updates.identity_resume_token_expires_at) > Date.now());
}
{
  let queried = false;
  const token = await ensureIdentityResumeToken({ from() { queried = true; } }, validTokenProfile);
  assert.equal(token, validTokenProfile.identity_resume_token);
  assert.equal(queried, false, 'a valid unexpired token should not rotate unexpectedly');
}

const activeApproved = {
  role: 'assembler',
  status: 'active',
  application_status: 'approved',
  tier: 'starter',
  identity_verified: true,
  contractor_agreement_signed_at: '2026-07-13T00:00:00.000Z',
  code_of_conduct_agreed_at: '2026-07-13T00:00:00.000Z',
  application_fee_waived: true,
};
assert.equal(isActiveApprovedEaserProfile(activeApproved), true);
assert.equal(isActiveApprovedEaserProfile({ ...activeApproved, status: 'suspended' }), false);
assert.equal(isActiveApprovedEaserProfile({ ...activeApproved, application_status: 'applied' }), false);
assert.equal(isActiveApprovedEaserProfile({ ...activeApproved, role: 'customer' }), false);
assert.equal(isActiveApprovedEaserProfile({ ...activeApproved, identity_verified: false }), false);
assert.equal(isActiveApprovedEaserProfile({ ...activeApproved, application_fee_refunded: true }), false);
assert.equal(isActiveApprovedEaserProfile({
  ...activeApproved,
  application_fee_waived: false,
  application_fee_paid: false,
  fee_waived_by_owner: false,
}), false);

function easerAccessMocks(profileResult) {
  const authClient = {
    auth: {
      async getUser(token) {
        assert.equal(token, 'test-token');
        return { data: { user: { id: 'easer-1', email: 'easer@example.com' } }, error: null };
      },
    },
  };
  const chain = {
    select() { return chain; },
    eq(field, value) { assert.equal(field, 'id'); assert.equal(value, 'easer-1'); return chain; },
    async maybeSingle() { return profileResult; },
  };
  const supabase = { from(table) { assert.equal(table, 'profiles'); return chain; } };
  return { authClient, supabase };
}

{
  const mocks = easerAccessMocks({ data: { id: 'easer-1', ...activeApproved }, error: null });
  const access = await requireActiveApprovedEaser({ headers: { authorization: 'Bearer test-token' } }, mocks);
  assert.equal(access.ok, true);
  assert.equal(access.user.id, 'easer-1');
}
{
  const mocks = easerAccessMocks({ data: { id: 'easer-1', ...activeApproved, status: 'suspended' }, error: null });
  const access = await requireActiveApprovedEaser({ headers: { authorization: 'Bearer test-token' } }, mocks);
  assert.deepEqual({ ok: access.ok, status: access.status }, { ok: false, status: 403 });
}

assert.equal(isApplicationFeeSatisfied({ application_fee_paid: true }), true);
assert.equal(isApplicationFeeSatisfied({ application_fee_waived: true }), true);
assert.equal(isApplicationFeeSatisfied({ fee_waived_by_owner: true }), true);
assert.equal(isApplicationFeeSatisfied({ application_fee_paid: true, application_fee_refunded: true }), false);
assert.equal(isApplicationFeeSatisfied({ application_fee_paid: false, application_fee_waived: false }), false);
assert.equal(EASER_APPLICATION_FEE_CENTS, 3000);
assert.equal(EASER_APPLICATION_FEE_CURRENCY, 'usd');

function applicationFeeStatusMock(result) {
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return { from(table) { assert.equal(table, 'profiles'); return chain; } };
}
const availableFeeStatus = await getEaserApplicationFeeStatus(applicationFeeStatusMock({ count: 19, error: null }));
assert.equal(availableFeeStatus.waiverAvailable, true);
assert.equal(availableFeeStatus.amountCents, 0);
const fullFeeStatus = await getEaserApplicationFeeStatus(applicationFeeStatusMock({ count: 20, error: null }));
assert.equal(fullFeeStatus.waiverAvailable, false);
assert.equal(fullFeeStatus.amountCents, EASER_APPLICATION_FEE_CENTS);
await assert.rejects(
  getEaserApplicationFeeStatus(applicationFeeStatusMock({ count: null, error: { message: 'count failed' } })),
  /count failed/,
);

const readyProfile = {
  ...activeApproved,
  contractor_agreement_signed_at: '2026-07-13T00:00:00.000Z',
  code_of_conduct_agreed_at: '2026-07-13T00:00:00.000Z',
  contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
  identity_verified: true,
  is_available: true,
  phone: '512-555-0100',
  application_fee_paid: false,
  application_fee_waived: false,
  fee_waived_by_owner: false,
};
const unpaidReadiness = await getEaserReadiness(readyProfile, { connectRequired: false });
assert.equal(unpaidReadiness.isReady, false);
assert.ok(unpaidReadiness.missingItems.includes('Application fee paid or explicitly waived'));
const waivedReadiness = await getEaserReadiness({ ...readyProfile, application_fee_waived: true }, { connectRequired: false });
assert.equal(waivedReadiness.isReady, true);
const ownerWaivedReadiness = await getEaserReadiness({ ...readyProfile, fee_waived_by_owner: true }, { connectRequired: false });
assert.equal(ownerWaivedReadiness.isReady, true);

assert.equal(deriveOfferLocation('123 Main Street Apt 4, Austin, TX 78701, USA'), 'Austin, TX 78701');
assert.equal(deriveOfferLocation('123 Main Street, Round Rock, TX, 78664'), 'Round Rock, TX 78664');
assert.equal(deriveOfferLocation('123 Main Street, Private Person, TX 78701'), 'Austin-area service zone');
assert.equal(deriveOfferLocation('123 Main Street, Austin, TX'), 'Austin-area service zone');
assert.doesNotMatch(deriveOfferLocation('123 Main Street Apt 4, Austin, TX 78701'), /123|Main|Apt/i);

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  applyApi,
  verificationApi,
  webhookApi,
  webhookAlias,
  assignmentsApi,
  statusApi,
  evidenceApi,
  messageApi,
  applicationFeeHelper,
  applicationFeeStatusApi,
  ownerAddEaserApi,
  migration,
] = await Promise.all([
  load('api/assembler/apply.js'),
  load('api/assembler/verification-link.js'),
  load('api/assembler/stripe-webhook.js'),
  load('api/webhook/stripe-identity.js'),
  load('api/booking/my-assignments.js'),
  load('api/booking/easer-status.js'),
  load('api/booking/upload-evidence.js'),
  load('api/booking/message.js'),
  load('api/_easer-application-fee.js'),
  load('api/assembler/application-fee-status.js'),
  load('api/owner/add-easer.js'),
  load('api/migrations/034_easer_onboarding_and_message_security.sql'),
]);

assert.match(applyApi, /An application with this email already exists/);
assert.ok(
  applyApi.indexOf('if (existingProfile)') < applyApi.indexOf('auth.admin.createUser'),
  'repeat applications must stop before any auth/profile mutation',
);
assert.match(applyApi, /claimFoundingEaserApplicationStatus/);
assert.match(applicationFeeHelper, /claim_founding_easer_waiver/);
assert.match(applicationFeeStatusApi, /getEaserApplicationFeeStatus/);
assert.doesNotMatch(applyApi, /waiving application fee for launch safety/);
assert.match(applyApi, /APPLICATION_FEE_PAYMENT_REQUIRED/);
assert.match(applyApi, /APPLICATION_PAYMENT_PENDING/);
assert.match(applyApi, /createApplicationFeeContinuationToken/);
assert.match(applyApi, /finalizeEaserApplicationSubmission/);
assert.doesNotMatch(applyApi, /paymentMethodId/);
assert.doesNotMatch(applyApi, /if \(!foundingApplication\.feeWaived && !paymentIntentId\)/);
const publicSuccessBuilder = applyApi.slice(
  applyApi.indexOf('function applicationSuccessResponse'),
  applyApi.indexOf('\nasync function cleanupFreshApplicant'),
);
assert.doesNotMatch(publicSuccessBuilder, /verificationResumeUrl|verificationUrl/, 'anonymous application response must not disclose an Identity bearer URL');
assert.match(verificationApi, /identity_resume_token_expires_at/);
assert.match(verificationApi, /isIdentityResumeTokenValid/);
assert.match(verificationApi, /identity_resume_link_reissued/);
assert.match(verificationApi, /replacementSent/);
assert.match(verificationApi, /Agreement acceptance could not be saved/);
assert.match(verificationApi, /signed name must match the full legal name/i);
assert.match(ownerAddEaserApi, /time-limited onboarding link/);
assert.doesNotMatch(ownerAddEaserApi, /reusable onboarding link/);
assert.match(ownerAddEaserApi, /emailDelivered/);
assert.match(webhookApi, /updateProfileRequired/);
assert.match(webhookApi, /identity_resume_token_expires_at:\s*null/);
assert.match(webhookApi, /Webhook processing failed and is retryable/);
assert.match(webhookAlias, /export \{ default \} from '\.\.\/assembler\/stripe-webhook\.js'/);

for (const [name, source] of [
  ['my assignments', assignmentsApi],
  ['Easer status', statusApi],
  ['evidence upload', evidenceApi],
  ['messages', messageApi],
]) {
  // Both canonical guards live in _easer-access.js and enforce the same
  // active/approved/identity/agreement/closure-blocking credential set. The
  // assigned-work endpoints use requireAssignedWorkEaser so a fee-refund-held
  // Easer can still finish work already bound to them (scoped by assembler_id),
  // while new-offer access stays paused. Reject any ad-hoc/inline guard.
  assert.match(
    source,
    /require(?:ActiveApproved|AssignedWork)Easer/,
    `${name} must use a canonical _easer-access guard`,
  );
}
assert.match(messageApi, /bk\.assembler_id !== easerAccess\.user\.id/);
assert.match(messageApi, /select\('id, booking_id, sender, sender_user_id, recipient_type, recipient_user_id, body, created_at, read_at'\)/);
assert.match(messageApi, /sender_user_id\.eq\.\$\{easerAccess\.user\.id\},recipient_user_id\.eq\.\$\{easerAccess\.user\.id\}/);
assert.doesNotMatch(messageApi, /sender\.eq\.assembler,recipient_type\.eq\.assembler/);
assert.match(messageApi, /sender_user_id:\s*authenticatedUser\?\.id \|\| null/);
assert.match(messageApi, /recipient_type:\s*resolvedRecipient/);
assert.match(messageApi, /recipient_user_id:\s*resolvedSender === 'owner' && resolvedRecipient === 'assembler'[\s\S]*?booking\.assembler_id/);
assert.match(messageApi, /message\.recipient_user_id === easerAccess\.user\.id/);
assert.match(messageApi, /readQuery = readQuery\.eq\('recipient_user_id', easerAccess\.user\.id\)/);
assert.match(messageApi, /\.eq\('recipient_type', readRecipient\)/);
assert.match(messageApi, /message_notification_failed/);
assert.match(messageApi, /Message saved, but the notification was not delivered/);
assert.match(assignmentsApi, /_offer_location = deriveOfferLocation/);
assert.match(assignmentsApi, /delete b\.address/);

assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.claim_founding_easer_waiver\(uuid, integer\)\s+TO service_role/);
assert.match(migration, /profiles_guard_easer_fee_readiness/);
assert.match(migration, /application_fee_refunded/);
assert.match(migration, /application_fee_refund_id/);
assert.match(migration, /ALTER TABLE public\.messages ENABLE ROW LEVEL SECURITY/);
assert.match(migration, /messages_assigned_active_easer_select/);
assert.match(migration, /SECURITY DEFINER[\s\S]*can_read_easer_booking_messages|can_read_easer_booking_messages[\s\S]*SECURITY DEFINER/);
assert.match(migration, /REVOKE ALL ON TABLE public\.messages FROM PUBLIC, anon, authenticated/);
assert.match(migration, /GRANT SELECT ON TABLE public\.messages TO authenticated/);

console.log('test-easer-security-checkpoint: PASS');
