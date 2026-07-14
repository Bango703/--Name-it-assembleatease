import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applicationAttemptMatches,
  createApplicationFeeContinuationToken,
  easerApplicationFeeConsentMetadata,
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_CONSENT_VERSION,
  EASER_APPLICATION_FEE_CONTINUATION_TTL_MS,
  hasEaserApplicationFeeConsent,
  hashApplicationAttemptId,
  isValidApplicationAttemptId,
  validateEaserApplicationPaymentIntent,
  verifyApplicationFeeContinuationToken,
} from '../api/_easer-application-fee.js';
import { finalizeEaserApplicationSubmission } from '../api/assembler/apply.js';

const testSecret = 'test-secret-that-is-long-and-not-used-outside-this-test';
const attemptId = 'A'.repeat(43);
assert.equal(isValidApplicationAttemptId(attemptId), true);
assert.equal(isValidApplicationAttemptId('short'), false);
const attemptHash = hashApplicationAttemptId(attemptId);
assert.match(attemptHash, /^[a-f0-9]{64}$/);
assert.equal(applicationAttemptMatches(attemptId, attemptHash), true);
assert.equal(applicationAttemptMatches('B'.repeat(43), attemptHash), false);

const now = Date.now();
const continuationToken = createApplicationFeeContinuationToken({
  profileId: '11111111-1111-4111-8111-111111111111',
  paymentIntentId: 'pi_test_application_fee_1',
  now,
  secret: testSecret,
});
const continuation = verifyApplicationFeeContinuationToken(continuationToken, {
  now: now + 1_000,
  secret: testSecret,
});
assert.equal(continuation.profileId, '11111111-1111-4111-8111-111111111111');
assert.equal(continuation.paymentIntentId, 'pi_test_application_fee_1');
assert.equal(continuation.expiresAt, now + EASER_APPLICATION_FEE_CONTINUATION_TTL_MS);
assert.throws(
  () => verifyApplicationFeeContinuationToken(`${continuationToken}x`, { now, secret: testSecret }),
  /invalid or expired/,
);
assert.throws(
  () => verifyApplicationFeeContinuationToken(continuationToken, {
    now: now + EASER_APPLICATION_FEE_CONTINUATION_TTL_MS + 1,
    secret: testSecret,
  }),
  /invalid or expired/,
);
assert.throws(
  () => verifyApplicationFeeContinuationToken(continuationToken, { now, secret: `${testSecret}-wrong` }),
  /invalid or expired/,
);

const authoritativePaymentIntent = {
  id: 'pi_test_application_fee_1',
  status: 'succeeded',
  amount: EASER_APPLICATION_FEE_CENTS,
  amount_received: EASER_APPLICATION_FEE_CENTS,
  currency: 'usd',
  customer: 'cus_test_1',
  metadata: {
    type: 'assembler_application_fee',
    userId: '11111111-1111-4111-8111-111111111111',
  },
};
assert.equal(validateEaserApplicationPaymentIntent(authoritativePaymentIntent, {
  userId: authoritativePaymentIntent.metadata.userId,
  customerId: 'cus_test_1',
  requireSucceeded: true,
}), true);
assert.throws(() => validateEaserApplicationPaymentIntent({
  ...authoritativePaymentIntent,
  amount: EASER_APPLICATION_FEE_CENTS - 1,
}, { userId: authoritativePaymentIntent.metadata.userId }), /canonical fee/);
assert.throws(() => validateEaserApplicationPaymentIntent(authoritativePaymentIntent, {
  userId: authoritativePaymentIntent.metadata.userId,
  paymentIntentId: 'pi_wrong',
}), /canonical fee/);
assert.throws(() => validateEaserApplicationPaymentIntent(authoritativePaymentIntent, {
  userId: authoritativePaymentIntent.metadata.userId,
  customerId: 'cus_wrong',
}), /canonical fee/);
assert.throws(() => validateEaserApplicationPaymentIntent(authoritativePaymentIntent, {
  userId: authoritativePaymentIntent.metadata.userId,
  requireConsent: true,
}), /canonical fee/);
const consentedPaymentIntent = {
  ...authoritativePaymentIntent,
  metadata: {
    ...authoritativePaymentIntent.metadata,
    ...easerApplicationFeeConsentMetadata(new Date('2026-07-13T12:00:00.000Z')),
  },
};
assert.equal(hasEaserApplicationFeeConsent(consentedPaymentIntent), true);
assert.equal(hasEaserApplicationFeeConsent({
  ...consentedPaymentIntent,
  metadata: { ...consentedPaymentIntent.metadata, applicationFeeConsentAt: 'not-a-date' },
}), false);
assert.equal(consentedPaymentIntent.metadata.applicationFeeConsentVersion, EASER_APPLICATION_FEE_CONSENT_VERSION);
assert.equal(validateEaserApplicationPaymentIntent(consentedPaymentIntent, {
  userId: authoritativePaymentIntent.metadata.userId,
  paymentIntentId: authoritativePaymentIntent.id,
  customerId: 'cus_test_1',
  requireSucceeded: true,
  requireConsent: true,
}), true);
assert.throws(() => validateEaserApplicationPaymentIntent({
  ...authoritativePaymentIntent,
  amount_received: EASER_APPLICATION_FEE_CENTS - 1,
}, { userId: authoritativePaymentIntent.metadata.userId, requireSucceeded: true }), /canonical fee/);
assert.throws(() => validateEaserApplicationPaymentIntent({
  ...authoritativePaymentIntent,
  metadata: { ...authoritativePaymentIntent.metadata, userId: 'wrong-user' },
}, { userId: authoritativePaymentIntent.metadata.userId }), /canonical fee/);

// A replay after the authoritative application transition is read-only and
// cannot send notifications or create a second Identity token.
{
  const appliedProfile = {
    id: authoritativePaymentIntent.metadata.userId,
    role: 'assembler',
    status: 'pending',
    application_status: 'applied',
    application_fee_paid: true,
    application_fee_waived: false,
    fee_waived_by_owner: false,
    stripe_payment_intent_id: authoritativePaymentIntent.id,
    founding_easer: false,
    founding_easer_number: null,
  };
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    async maybeSingle() { return { data: appliedProfile, error: null }; },
  };
  const sb = { from(table) { assert.equal(table, 'profiles'); return chain; } };
  const result = await finalizeEaserApplicationSubmission({
    sb,
    userId: appliedProfile.id,
    expectedPaymentIntentId: authoritativePaymentIntent.id,
  });
  assert.equal(result.success, true);
  assert.equal(result.alreadyFinalized, true);
  assert.equal(result.applicationFee.paid, true);
}

const load = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  applyApi,
  finalizeApi,
  feeStatusApi,
  webhookApi,
  updateApi,
  onboardingHelper,
  applyPage,
  migration,
] = await Promise.all([
  load('api/assembler/apply.js'),
  load('api/assembler/application-fee-finalize.js'),
  load('api/assembler/application-fee-status.js'),
  load('api/assembler/stripe-webhook.js'),
  load('api/assembler/update.js'),
  load('api/_assembler-onboarding.js'),
  load('assembler/apply.html'),
  load('api/migrations/034_easer_onboarding_and_message_security.sql'),
]);

assert.ok(
  applyApi.indexOf('isActiveInstantBookingZip(cleanZip)') < applyApi.indexOf('const sb = getSupabase()'),
  'active-market rejection must occur before database/auth/profile mutation',
);
assert.match(applyApi, /code: 'EASER_MARKET_NOT_ACTIVE'/);
assert.match(applyApi, /application_status: APPLICATION_PAYMENT_PENDING/);
assert.match(applyApi, /createApplicationFeeContinuationToken/);
assert.match(applyApi, /applicationFeeConsent/);
assert.match(applyApi, /easerApplicationFeeConsentMetadata/);
assert.match(applyApi, /clientSecret: feeConsentRecorded \? paymentIntent\.client_secret : null/);
assert.match(applyApi, /consentRequired: !feeConsentRecorded/);
assert.match(applyApi, /status: 202/);
assert.match(applyApi, /paymentRequired: true/);
assert.doesNotMatch(applyApi, /paymentMethodId/);
assert.doesNotMatch(applyApi, /payment_confirmed: succeeded/);
assert.match(applyApi, /\.eq\('application_status', APPLICATION_PAYMENT_PENDING\)/);
assert.match(applyApi, /\.eq\(feeField, true\)/);
assert.match(onboardingHelper, /options\.expectNoToken/);

assert.match(finalizeApi, /verifyApplicationFeeContinuationToken/);
assert.match(finalizeApi, /paymentIntents\.retrieve/);
assert.match(finalizeApi, /requireSucceeded: true/);
assert.match(finalizeApi, /requireConsent: true/);
assert.match(finalizeApi, /customerId: profile\.stripe_customer_id/);
assert.match(finalizeApi, /APPLICATION_FEE_FINALIZATION_CLOSED/);
assert.match(finalizeApi, /\.eq\('stripe_payment_intent_id', continuation\.paymentIntentId\)/);
assert.match(webhookApi, /finalizeEaserApplicationSubmission/);
assert.match(webhookApi, /applicationProfile\.stripe_payment_intent_id !== pi\.id/);
assert.match(webhookApi, /customerId: applicationProfile\.stripe_customer_id/);
assert.match(webhookApi, /requireConsent: true/);
assert.match(feeStatusApi, /isActiveInstantBookingZip/);
assert.match(feeStatusApi, /standardAmountDisplay/);
assert.match(feeStatusApi, /Cache-Control', 'no-store/);
assert.ok(
  feeStatusApi.indexOf('if (marketRequested && !marketActive)') < feeStatusApi.indexOf('getEaserApplicationFeeStatus(getSupabase())'),
  'inactive-market waitlist preflight must not depend on fee-inventory database state',
);

assert.match(updateApi, /validateEaserApplicationPaymentIntent/);
// Rejection refund is aggregate-truth safe: it issues a real Stripe refund for
// the remaining balance and refuses to mark the application refunded unless the
// aggregate reaches the exact canonical fee with a confirmed refund id + time.
assert.match(updateApi, /stripe\.refunds\.create/);
assert.match(updateApi, /refundedCents !== EASER_APPLICATION_FEE_CENTS \|\| !refundId \|\| !refundedAt/);
assert.match(updateApi, /paymentIntents\.cancel/);
assert.match(updateApi, /APPLICATION_REFUND_PENDING/);
assert.match(updateApi, /APPLICATION_REJECTION_PERSIST_FAILED/);
assert.match(updateApi, /finalize_easer_application_decision/);
assert.doesNotMatch(updateApi, /\.update\(rejectionUpdates\)/);
assert.match(updateApi, /application_fee_refunded_at/);
assert.match(updateApi, /stripe_customer_id/);
assert.match(updateApi, /notifications are configured and enabled on your device/);
assert.match(migration, /application_fee_refunded boolean NOT NULL DEFAULT false/);
assert.match(migration, /idx_profiles_application_fee_refund_id_unique/);
assert.match(migration, /NOT COALESCE\(NEW\.application_fee_refunded, false\)/);

assert.match(applyPage, /application-fee-status/);
assert.match(applyPage, /\/api\/config\/public-key/);
assert.match(applyPage, /https:\/\/js\.stripe\.com\/v3\//);
assert.match(applyPage, /fee-consent/);
assert.match(applyPage, /applicationFeeConsent/);
assert.match(applyPage, /full application fee is returned to the original payment method/);
assert.match(applyPage, /Applicant-withdrawal, duplicate-charge, and payment-error requests are reviewed/);
assert.match(applyPage, /one-time.*application fee/i);
assert.match(applyPage, /confirmCardPayment/);
assert.match(applyPage, /application-fee-finalize/);
assert.match(applyPage, /applicationAttemptId/);
assert.match(applyPage, /EASER_MARKET_NOT_ACTIVE/);
assert.match(applyPage, /Join Easer Waitlist/);
assert.match(applyPage, /id="state"/);
const submitHandler = applyPage.slice(applyPage.indexOf("document.getElementById('apply-form').addEventListener"));
assert.match(submitHandler, /validateMarketLocation\(data\)[\s\S]*fetchApplicationPreflight\(data\.state, data\.zip\)[\s\S]*preflight\.market[\s\S]*validateApplicationData\(data\)/);
assert.doesNotMatch(applyPage, /FOUNDING_EASER_FEE_WAIVED/);
assert.doesNotMatch(applyPage, /paymentMethodId/);
assert.doesNotMatch(applyPage, /<script[^>]+src=["']https:\/\/js\.stripe\.com\/v3\//i);

console.log('test-easer-paid-application: PASS');
