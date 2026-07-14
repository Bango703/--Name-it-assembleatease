import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimit } from '../_ratelimit.js';
import { logActivity } from '../booking/_activity.js';
import { isActiveInstantBookingZip } from '../_source-of-truth.js';
import { formatUsPhone, normalizeUsPhone } from '../_phone.js';
import {
  buildIdentityResumeUrl,
  getClientIp,
  CONTRACTOR_AGREEMENT_VERSION,
  recordAgreementAcceptance,
  rotateIdentityResumeToken,
  updateProfileRequired,
} from '../_assembler-onboarding.js';
import {
  applicationAttemptMatches,
  claimFoundingEaserApplicationStatus,
  createApplicationFeeContinuationToken,
  EASER_APPLICATION_FEE_CENTS,
  EASER_APPLICATION_FEE_CONSENT_VERSION,
  easerApplicationFeeConsentMetadata,
  EASER_APPLICATION_FEE_CURRENCY,
  EASER_APPLICATION_FEE_DISPLAY,
  hasEaserApplicationFeeRefundHold,
  hasEaserApplicationFeeConsent,
  hashApplicationAttemptId,
  isValidApplicationAttemptId,
  validateEaserApplicationPaymentIntent,
} from '../_easer-application-fee.js';
import {
  loadEaserApplicationFeeRefundTruth,
  reconcileEaserApplicationFeeRefund,
} from '../_easer-application-refund.js';
import { isEaserClosureBlocking } from '../_easer-closure.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const APPLICATION_PAYMENT_PENDING = 'payment_pending';
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const VALID_SERVICES = [
  'Furniture Assembly',
  'TV & Display Mounting',
  'Smart Home Installation',
  'Fitness Equipment',
  'Outdoor & Playsets',
  'Office Assembly',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!await rateLimit(ip, 'apply')) return res.status(429).json({ error: 'Too many requests. Please try again later.' });

  const {
    fullName, email, phone, city, state, zip,
    servicesOffered, hasTools, hasTransport,
    yearsExperience, bio, codeOfConduct,
    contractorAgreementSigned,
    applicationAttemptId,
    applicationFeeConsent,
  } = req.body || {};

  // ---- Validation ----
  if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (fullName.trim().split(/\s+/).filter(Boolean).length < 2) return res.status(400).json({ error: 'Please enter your first and last name.' });
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  const cleanPhone = normalizeUsPhone(phone);
  if (!cleanPhone) return res.status(400).json({ error: 'Enter a valid 10-digit U.S. phone number', code: 'INVALID_PHONE' });
  if (!city?.trim()) return res.status(400).json({ error: 'City is required' });
  const cleanState = String(state || '').trim().toUpperCase();
  if (!US_STATE_CODES.has(cleanState)) {
    return res.status(400).json({ error: 'Enter a valid two-letter US state code', code: 'INVALID_STATE' });
  }
  if (!zip?.trim()) return res.status(400).json({ error: 'Zip code is required' });
  const cleanZip = String(zip).trim();
  if (!/^\d{5}$/.test(cleanZip)) {
    return res.status(400).json({ error: 'Enter a valid 5-digit ZIP code', code: 'INVALID_ZIP' });
  }
  if (cleanState !== 'TX' || !isActiveInstantBookingZip(cleanZip)) {
    return res.status(409).json({
      error: 'Easer applications are not active for this ZIP yet. Join the Easer waitlist and no application fee will be collected.',
      code: 'EASER_MARKET_NOT_ACTIVE',
      waitlistEndpoint: '/api/waitlist',
    });
  }
  if (!Array.isArray(servicesOffered) || !servicesOffered.length) return res.status(400).json({ error: 'Select at least one service' });
  const validServices = servicesOffered.filter(s => VALID_SERVICES.includes(s));
  if (!validServices.length) return res.status(400).json({ error: 'Invalid service selection' });
  if (typeof hasTools !== 'boolean') return res.status(400).json({ error: 'Tools question is required' });
  if (typeof hasTransport !== 'boolean') return res.status(400).json({ error: 'Transportation question is required' });
  const parsedYearsExperience = Number(yearsExperience);
  if (!Number.isInteger(parsedYearsExperience) || parsedYearsExperience < 0 || parsedYearsExperience > 80) {
    return res.status(400).json({ error: 'Years of experience must be between 0 and 80' });
  }
  if (codeOfConduct !== true) return res.status(400).json({ error: 'You must agree to the code of conduct' });
  if (contractorAgreementSigned !== true) return res.status(400).json({ error: 'You must read and sign the Independent Contractor Agreement' });
  if (!isValidApplicationAttemptId(applicationAttemptId)) {
    return res.status(400).json({ error: 'A secure application attempt identifier is required. Refresh and try again.' });
  }

  const cleanName = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();
  const applicationAttemptHash = hashApplicationAttemptId(applicationAttemptId);
  const feeConsentGiven = applicationFeeConsent === true;
  const sb = getSupabase();
  const { data: existingProfile, error: existingProfileErr } = await sb
    .from('profiles')
    .select('*')
    .eq('email', cleanEmail)
    .maybeSingle();
  if (existingProfileErr) return res.status(500).json({ error: 'Unable to check application status. Please try again.' });
  if (existingProfile?.role !== undefined && existingProfile.role !== 'assembler') {
    return res.status(409).json({ error: 'An account with this email already exists. Please use a different email or contact support.' });
  }

  if (existingProfile) {
    const { data: existingAuthData, error: existingAuthError } = await sb.auth.admin.getUserById(existingProfile.id);
    const existingAuthUser = existingAuthData?.user;
    if (existingAuthError || !existingAuthUser) {
      console.error('Application draft auth lookup failed:', existingAuthError);
      return res.status(503).json({ error: 'The existing application could not be verified. Please try again.' });
    }
    if (!isRecoverableApplication(existingProfile, existingAuthUser, applicationAttemptId)) {
      return res.status(409).json({
        error: 'An application with this email already exists. Use the link sent to that email or contact support.',
      });
    }
    try {
      const resumed = await resumeApplicationDraft({
        sb,
        profile: existingProfile,
        applicationAttemptHash,
        applicationFeeConsent: feeConsentGiven,
      });
      return res.status(resumed.status).json(resumed.body);
    } catch (resumeError) {
      console.error('Application draft resume failed:', resumeError?.message || resumeError);
      return res.status(503).json({
        error: 'The existing application could not be resumed safely. Retry this same application or contact support.',
        code: 'APPLICATION_RESUME_RETRYABLE',
      });
    }
  }

  const agreementIp = getClientIp(req);
  const agreementUserAgent = String(req.headers['user-agent'] || '').slice(0, 500);

  // Generate a random temporary password — the Easer sets their real password after approval.
  const tempPassword = randomUUID() + randomUUID();

  // Email knowledge is not authority to resume an orphaned auth record. Only
  // possession of the high-entropy attempt capability created by this browser
  // may continue the same unfinished application.
  let authUser = null;
  let authUserCreated = false;
  try {
    const existingAuthUser = await findAuthUserByEmail(sb, cleanEmail);
    if (existingAuthUser) {
      if (String(existingAuthUser.user_metadata?.role || '').toLowerCase() !== 'assembler'
          || !applicationAttemptMatches(
            applicationAttemptId,
            existingAuthUser.user_metadata?.application_attempt_hash,
          )) {
        return res.status(409).json({
          error: 'An application with this email already exists. Use the link sent to that email or contact support.',
        });
      }
      authUser = existingAuthUser;
    }
  } catch (lookupErr) {
    console.error('Auth duplicate lookup failed:', lookupErr);
    return res.status(500).json({ error: 'Unable to verify application eligibility. Please try again.' });
  }

  if (!authUser) {
    const { data: authData, error: authError } = await sb.auth.admin.createUser({
      email: cleanEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: {
        role: 'assembler',
        full_name: cleanName,
        application_attempt_hash: applicationAttemptHash,
      },
    });
    if (authError || !authData?.user) {
      console.error('Auth create error:', authError);
      return res.status(500).json({ error: 'Failed to create account' });
    }
    authUser = authData.user;
    authUserCreated = true;
  }

  const userId = authUser.id;

  // A paid applicant remains explicitly payment_pending until Stripe confirms
  // the exact server-created PaymentIntent. Owner review cannot start earlier.
  const coreProfile = {
    id: userId,
    full_name: cleanName,
    email: cleanEmail,
    phone: cleanPhone,
    role: 'assembler',
    city: city.trim(),
    state: cleanState,
    zip: cleanZip,
    status: 'pending',
    application_status: APPLICATION_PAYMENT_PENDING,
    tier: 'pending',
    is_available: false,
    identity_verified: false,
  };

  const { error: profileError } = await sb.from('profiles').insert(coreProfile);

  if (profileError) {
    console.error('Profile insert error:', JSON.stringify(profileError));
    await cleanupFreshApplicant(sb, userId, { deleteAuth: authUserCreated });
    return res.status(500).json({ error: 'Failed to save application. ' + (profileError.message || '') });
  }

  // Assembler-specific columns — all known-good after migration 018
  try {
    await updateProfileRequired(sb, userId, {
      services_offered: validServices,
      has_tools: hasTools,
      has_transport: hasTransport,
      years_experience: parsedYearsExperience,
      bio: bio?.trim() || null,
      tier: 'pending',
      identity_verified: false,
      application_status: APPLICATION_PAYMENT_PENDING,
    }, 'Easer application details');
  } catch (detailError) {
    console.error('Easer application details failed:', detailError?.message || detailError);
    await cleanupFreshApplicant(sb, userId, { deleteAuth: authUserCreated });
    return res.status(500).json({ error: 'Failed to save application details. Please try again.' });
  }

  let foundingApplication;
  try {
    foundingApplication = await claimFoundingEaserApplicationStatus(sb, userId);
  } catch (claimError) {
    console.error('Founding Easer waiver claim failed:', claimError?.message || claimError);
    await cleanupFreshApplicant(sb, userId, { deleteAuth: authUserCreated });
    return res.status(503).json({
      error: 'Application fee status could not be verified. Nothing was submitted; please try again.',
    });
  }

  try {
    await recordAgreementAcceptance(sb, {
      profileId: userId,
      signedName: cleanName,
      agreementIp,
      agreementUserAgent,
    });
  } catch (agreementError) {
    console.error('Agreement acceptance save failed:', agreementError?.message || agreementError);
    await cleanupFreshApplicant(sb, userId, { deleteAuth: authUserCreated });
    return res.status(500).json({ error: 'Failed to save required agreement acceptance. Nothing was submitted; please try again.' });
  }

  try {
    if (foundingApplication.feeWaived) {
      const finalized = await finalizeEaserApplicationSubmission({ sb, userId });
      return res.status(200).json(finalized);
    }

    const { data: profile, error: refreshedProfileError } = await sb
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (refreshedProfileError || !profile) {
      throw new Error(refreshedProfileError?.message || 'Application draft could not be reloaded');
    }
    const prepared = await preparePaidApplication({
      sb,
      profile,
      applicationAttemptHash,
      applicationFeeConsent: feeConsentGiven,
    });
    return res.status(prepared.status).json(prepared.body);
  } catch (completionError) {
    console.error('Application completion preparation failed:', completionError?.message || completionError);
    return res.status(503).json({
      error: 'The application is saved, but payment or onboarding preparation could not finish. Retry this same application; do not start a new one.',
      code: 'APPLICATION_PREPARATION_RETRYABLE',
    });
  }
}

function isRecoverableApplication(profile, authUser, applicationAttemptId) {
  if (!profile || !authUser || authUser.id !== profile.id || profile.role !== 'assembler') return false;
  if (!applicationAttemptMatches(
    applicationAttemptId,
    authUser.user_metadata?.application_attempt_hash,
  )) return false;
  const status = String(profile.status || '').trim().toLowerCase();
  const applicationStatus = String(profile.application_status || '').trim().toLowerCase();
  return status === 'pending'
    && [APPLICATION_PAYMENT_PENDING, 'applied'].includes(applicationStatus);
}

async function resumeApplicationDraft({
  sb,
  profile,
  applicationAttemptHash,
  applicationFeeConsent = false,
}) {
  if (String(profile.application_status || '').toLowerCase() === 'applied') {
    const finalized = await finalizeEaserApplicationSubmission({ sb, userId: profile.id });
    return { status: 200, body: finalized };
  }
  if (profile.application_fee_paid === true && !profile.stripe_payment_intent_id) {
    throw new Error('Paid application draft is missing its Stripe PaymentIntent');
  }
  if (profile.application_fee_waived === true || profile.fee_waived_by_owner === true) {
    const finalized = await finalizeEaserApplicationSubmission({ sb, userId: profile.id });
    return { status: 200, body: finalized };
  }

  let currentProfile = profile;
  if (!currentProfile.stripe_payment_intent_id) {
    const foundingApplication = await claimFoundingEaserApplicationStatus(sb, profile.id);
    if (foundingApplication.feeWaived) {
      const finalized = await finalizeEaserApplicationSubmission({ sb, userId: profile.id });
      return { status: 200, body: finalized };
    }
    const { data, error } = await sb.from('profiles').select('*').eq('id', profile.id).maybeSingle();
    if (error || !data) throw new Error(error?.message || 'Application draft could not be reloaded');
    currentProfile = data;
  }
  return preparePaidApplication({
    sb,
    profile: currentProfile,
    applicationAttemptHash,
    applicationFeeConsent,
  });
}

async function preparePaidApplication({
  sb,
  profile,
  applicationAttemptHash,
  applicationFeeConsent = false,
  stripeClient,
}) {
  if (hasEaserApplicationFeeRefundHold(profile)) {
    throw new Error('Application-fee refund activity requires owner review before this application can continue');
  }
  const stripe = stripeClient || (process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null);
  if (!stripe) throw new Error('Stripe application-fee processing is not configured');

  let stripeCustomerId = profile.stripe_customer_id || null;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: profile.email,
      name: profile.full_name,
      metadata: { userId: profile.id, role: 'assembler' },
    }, { idempotencyKey: `easer_application_customer_${profile.id}` });
    stripeCustomerId = customer.id;
  }

  let paymentIntent;
  if (profile.stripe_payment_intent_id) {
    paymentIntent = await stripe.paymentIntents.retrieve(profile.stripe_payment_intent_id);
  } else {
    paymentIntent = await stripe.paymentIntents.create({
      amount: EASER_APPLICATION_FEE_CENTS,
      currency: EASER_APPLICATION_FEE_CURRENCY,
      customer: stripeCustomerId,
      metadata: {
        userId: profile.id,
        type: 'assembler_application_fee',
        applicationAttemptHash,
        ...(applicationFeeConsent ? easerApplicationFeeConsentMetadata() : {}),
      },
      description: 'AssembleAtEase Easer Application Fee',
      receipt_email: profile.email,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    }, { idempotencyKey: `easer_application_fee_${profile.id}` });
  }

  validateEaserApplicationPaymentIntent(paymentIntent, {
    userId: profile.id,
    paymentIntentId: profile.stripe_payment_intent_id || paymentIntent.id,
    customerId: stripeCustomerId,
  });
  if (paymentIntent.status === 'canceled') {
    throw new Error('The application PaymentIntent was canceled and requires owner review');
  }

  if (applicationFeeConsent
      && !hasEaserApplicationFeeConsent(paymentIntent)
      && paymentIntent.status !== 'succeeded') {
    paymentIntent = await stripe.paymentIntents.update(paymentIntent.id, {
      metadata: {
        ...paymentIntent.metadata,
        ...easerApplicationFeeConsentMetadata(),
      },
    }, {
      idempotencyKey: `easer_application_fee_consent_${profile.id}_${paymentIntent.id}_${EASER_APPLICATION_FEE_CONSENT_VERSION}`,
    });
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: profile.id,
      paymentIntentId: profile.stripe_payment_intent_id || paymentIntent.id,
      customerId: stripeCustomerId,
    });
  }

  const succeeded = paymentIntent.status === 'succeeded';
  if (succeeded) {
    validateEaserApplicationPaymentIntent(paymentIntent, {
      userId: profile.id,
      paymentIntentId: paymentIntent.id,
      customerId: stripeCustomerId,
      requireSucceeded: true,
      requireConsent: true,
    });
    const refundTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId: profile.id,
      paymentIntentId: paymentIntent.id,
      customerId: stripeCustomerId,
    });
    if (refundTruth.hasLiveRefundActivity) {
      await reconcileEaserApplicationFeeRefund(sb, {
        assemblerId: profile.id,
        paymentIntentId: paymentIntent.id,
        customerId: stripeCustomerId,
        truth: refundTruth,
        reason: 'Application recovery observed application-fee refund activity',
      });
      throw new Error('Application-fee refund activity requires owner review before this application can continue');
    }
  }
  const paymentUpdates = {
    stripe_customer_id: stripeCustomerId,
    stripe_payment_intent_id: paymentIntent.id,
  };
  if (succeeded) {
    paymentUpdates.payment_confirmed = true;
    paymentUpdates.application_fee_paid = true;
  }
  let paymentPersistence = sb.from('profiles')
    .update(paymentUpdates)
    .eq('id', profile.id)
    .eq('status', 'pending')
    .eq('application_status', APPLICATION_PAYMENT_PENDING)
    .eq('application_fee_waived', false)
    .eq('fee_waived_by_owner', false)
    .eq('application_fee_refunded', false)
    .eq('application_fee_refunded_cents', 0)
    .eq('application_fee_refund_pending_cents', 0)
    .is('application_fee_refund_review_required_at', null);
  paymentPersistence = profile.stripe_payment_intent_id
    ? paymentPersistence.eq('stripe_payment_intent_id', paymentIntent.id)
    : paymentPersistence.is('stripe_payment_intent_id', null);
  paymentPersistence = profile.stripe_customer_id
    ? paymentPersistence.eq('stripe_customer_id', profile.stripe_customer_id)
    : paymentPersistence.is('stripe_customer_id', null);
  const { data: persistedProfile, error: paymentPersistenceError } = await paymentPersistence
    .select('*')
    .maybeSingle();
  if (paymentPersistenceError) {
    throw new Error(`Application fee preparation persistence failed: ${paymentPersistenceError.message || paymentPersistenceError}`);
  }
  if (!persistedProfile) {
    const { data: concurrentProfile } = await sb.from('profiles')
      .select('*')
      .eq('id', profile.id)
      .maybeSingle();
    if (String(concurrentProfile?.application_status || '').toLowerCase() === 'applied'
        && concurrentProfile?.application_fee_paid === true
        && concurrentProfile?.stripe_payment_intent_id === paymentIntent.id) {
      const finalized = await finalizeEaserApplicationSubmission({
        sb,
        userId: profile.id,
        expectedPaymentIntentId: paymentIntent.id,
        stripeClient: stripe,
      });
      return { status: 200, body: finalized };
    }
    if (!['succeeded', 'canceled'].includes(paymentIntent.status)) {
      try {
        await stripe.paymentIntents.cancel(paymentIntent.id, {}, {
          idempotencyKey: `easer_application_fee_abandon_${profile.id}_${paymentIntent.id}`,
        });
      } catch (cancelError) {
        console.error('Application PaymentIntent safety cancellation failed:', cancelError?.message || cancelError);
      }
    }
    throw new Error('Application state changed before payment preparation completed; no payment continuation was issued');
  }

  if (succeeded) {
    const finalized = await finalizeEaserApplicationSubmission({
      sb,
      userId: profile.id,
      expectedPaymentIntentId: paymentIntent.id,
      stripeClient: stripe,
    });
    return { status: 200, body: finalized };
  }

  const feeConsentRecorded = hasEaserApplicationFeeConsent(paymentIntent);
  if (feeConsentRecorded && !paymentIntent.client_secret) {
    throw new Error('Stripe did not return a client secret for the application fee');
  }
  const feeContinuationToken = createApplicationFeeContinuationToken({
    profileId: profile.id,
    paymentIntentId: paymentIntent.id,
  });
  return {
    status: 202,
    body: {
      success: false,
      paymentRequired: true,
      code: 'APPLICATION_FEE_PAYMENT_REQUIRED',
      clientSecret: feeConsentRecorded ? paymentIntent.client_secret : null,
      feeContinuationToken,
      consentRequired: !feeConsentRecorded,
      paymentStatus: paymentIntent.status,
      applicationFee: paidApplicationFeeResponse(),
      message: `Review and authorize the one-time ${EASER_APPLICATION_FEE_DISPLAY} application fee to finish submitting.`,
    },
  };
}

async function ensureFinalizationIdentityToken(sb, profile) {
  if (profile.identity_resume_token && profile.identity_resume_token_expires_at
      && new Date(profile.identity_resume_token_expires_at).getTime() > Date.now()) {
    return profile.identity_resume_token;
  }

  try {
    if (profile.identity_resume_token) {
      return await rotateIdentityResumeToken(sb, profile.id, {
        expectedToken: profile.identity_resume_token,
        allowExpiredExpected: true,
      });
    }
    return await rotateIdentityResumeToken(sb, profile.id, { expectNoToken: true });
  } catch (rotationError) {
    // A concurrent webhook/browser finalizer may have won token creation. Use
    // only the now-persisted valid token; never send a losing token value.
    const { data: refreshed, error } = await sb
      .from('profiles')
      .select('identity_resume_token, identity_resume_token_expires_at')
      .eq('id', profile.id)
      .maybeSingle();
    if (!error && refreshed?.identity_resume_token
        && new Date(refreshed.identity_resume_token_expires_at).getTime() > Date.now()) {
      return refreshed.identity_resume_token;
    }
    throw rotationError;
  }
}

export async function finalizeEaserApplicationSubmission({
  sb = getSupabase(),
  userId,
  expectedPaymentIntentId = null,
  stripeClient = null,
} = {}) {
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (profileError || !profile || profile.role !== 'assembler') {
    throw new Error(profileError?.message || 'Easer application profile not found');
  }
  if (expectedPaymentIntentId && profile.stripe_payment_intent_id !== expectedPaymentIntentId) {
    throw new Error('Application PaymentIntent does not match the profile');
  }
  if (isEaserClosureBlocking(profile)) {
    throw new Error('Account closure status blocks application finalization');
  }
  const feePaid = profile.application_fee_paid === true;
  const feeWaived = profile.application_fee_waived === true || profile.fee_waived_by_owner === true;
  if (feePaid && feeWaived) {
    throw new Error('Application fee truth is contradictory and requires owner review');
  }
  if (hasEaserApplicationFeeRefundHold(profile)) {
    throw new Error('Application-fee refund activity requires owner review before finalization');
  }
  if (!feePaid && !feeWaived) {
    throw new Error('Application fee is neither paid nor explicitly waived');
  }
  // Idempotent replay: an already-finalized application is read-only. Do not
  // run live Stripe verification, rotate an Identity token, or re-send owner /
  // applicant notifications. Refunds reconciled into the profile are still
  // caught by hasEaserApplicationFeeRefundHold() above; unreconciled Stripe
  // refunds are handled by the webhook refund handlers, not the finalizer.
  if (String(profile.application_status || '').toLowerCase() === 'applied') {
    return applicationSuccessResponse(profile, { alreadyFinalized: true });
  }
  if (feePaid) {
    if (!profile.stripe_payment_intent_id || !profile.stripe_customer_id) {
      throw new Error('Paid application is missing its stored Stripe identifiers');
    }
    const stripe = stripeClient || (process.env.STRIPE_SECRET_KEY
      ? new Stripe(process.env.STRIPE_SECRET_KEY)
      : null);
    if (!stripe) throw new Error('Stripe application-fee verification is unavailable');
    const refundTruth = await loadEaserApplicationFeeRefundTruth({
      stripe,
      assemblerId: userId,
      paymentIntentId: profile.stripe_payment_intent_id,
      customerId: profile.stripe_customer_id,
    });
    if (refundTruth.hasLiveRefundActivity) {
      await reconcileEaserApplicationFeeRefund(sb, {
        assemblerId: userId,
        paymentIntentId: profile.stripe_payment_intent_id,
        customerId: profile.stripe_customer_id,
        truth: refundTruth,
        reason: 'Application submission finalizer observed application-fee refund activity',
      });
      throw new Error('Application-fee refund activity requires owner review before finalization');
    }
  }
  if (String(profile.application_status || '').toLowerCase() !== APPLICATION_PAYMENT_PENDING) {
    throw new Error('Easer application is not awaiting payment finalization');
  }

  const feeField = feePaid
    ? 'application_fee_paid'
    : profile.application_fee_waived === true
      ? 'application_fee_waived'
      : 'fee_waived_by_owner';

  let transition = sb.from('profiles')
    .update({ application_status: 'applied' })
    .eq('id', userId)
    .eq('application_status', APPLICATION_PAYMENT_PENDING)
    .eq(feeField, true)
    .eq('application_fee_refunded', false)
    .eq('application_fee_refunded_cents', 0)
    .eq('application_fee_refund_pending_cents', 0)
    .is('application_fee_refund_review_required_at', null)
    .or('account_closure_status.is.null,account_closure_status.eq.cancelled');
  if (expectedPaymentIntentId) {
    transition = transition.eq('stripe_payment_intent_id', expectedPaymentIntentId);
  }
  const { data: finalizedProfile, error: transitionError } = await transition
    .select('*')
    .maybeSingle();
  if (transitionError) throw new Error(`Application finalization failed: ${transitionError.message || transitionError}`);
  if (!finalizedProfile) {
    const { data: concurrentProfile, error: concurrentError } = await sb
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();
    if (!concurrentError
        && String(concurrentProfile?.application_status || '').toLowerCase() === 'applied'
        && !hasEaserApplicationFeeRefundHold(concurrentProfile)) {
      return applicationSuccessResponse(concurrentProfile, { alreadyFinalized: true });
    }
    throw new Error('Application finalization lost its authoritative state transition');
  }

  const identityResumeToken = await ensureFinalizationIdentityToken(sb, finalizedProfile);
  const verificationResumeUrl = buildIdentityResumeUrl(identityResumeToken);

  const finalizedFeeWaived = finalizedProfile.application_fee_waived === true
    || finalizedProfile.fee_waived_by_owner === true;
  const agreementTs = finalizedProfile.contractor_agreement_signed_at;
  await logActivity(sb, {
    bookingId: null,
    eventType: 'assembler_application_submitted',
    actorType: 'assembler',
    actorId: userId,
    actorName: finalizedProfile.full_name,
    description: `Easer application submitted by ${finalizedProfile.full_name}. Contractor agreement and code of conduct accepted.`,
    metadata: {
      email: finalizedProfile.email,
      agreementAcceptedAt: agreementTs,
      agreementVersion: finalizedProfile.contractor_agreement_version || CONTRACTOR_AGREEMENT_VERSION,
      signedName: finalizedProfile.contractor_agreement_signed_name || finalizedProfile.full_name,
      codeOfConductAcceptedAt: finalizedProfile.code_of_conduct_agreed_at,
      servicesOffered: finalizedProfile.services_offered || [],
      foundingEaser: finalizedFeeWaived,
      foundingNumber: finalizedProfile.founding_easer_number || null,
      applicationFeePaid: finalizedProfile.application_fee_paid === true,
      paymentIntentId: finalizedProfile.stripe_payment_intent_id || null,
    },
  });

  try {
    const { error: waitlistUpdateError } = await sb.from('assembler_waitlist')
      .update({ status: 'applied', applied_at: new Date().toISOString() })
      .eq('email', String(finalizedProfile.email || '').toLowerCase())
      .eq('status', 'invited');
    if (waitlistUpdateError) throw waitlistUpdateError;
  } catch (waitlistError) {
    console.error('Application waitlist update error:', waitlistError?.message || waitlistError);
  }

  const servicesList = (finalizedProfile.services_offered || [])
    .map(service => `<li style="padding:3px 0">${esc(service)}</li>`)
    .join('');
  let ownerNotification = { ok: false, error: 'Owner notification not attempted' };
  try {
    ownerNotification = await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      replyTo: finalizedProfile.email,
      subject: 'New Easer Application - ' + finalizedProfile.full_name,
      html: buildOwnerEmail({
        cleanName: finalizedProfile.full_name,
        cleanEmail: finalizedProfile.email,
        cleanPhone: finalizedProfile.phone,
        city: finalizedProfile.city,
        state: finalizedProfile.state,
        zip: finalizedProfile.zip,
        yearsExperience: finalizedProfile.years_experience,
        hasTools: finalizedProfile.has_tools,
        hasTransport: finalizedProfile.has_transport,
        bio: finalizedProfile.bio,
        servicesList,
        paymentIntentId: finalizedProfile.stripe_payment_intent_id,
        feeWaived: finalizedFeeWaived,
        foundingNumber: finalizedProfile.founding_easer_number,
        verificationResumeUrl,
      }),
      meta: { notificationType: 'easer_application_owner_notice', recipientType: 'owner', disableDedupe: true },
    });
  } catch (error) {
    console.error('Owner application email error:', error);
    ownerNotification = { ok: false, error: error?.message || String(error) };
  }

  let applicantNotification = { ok: false, error: 'Applicant notification not attempted' };
  try {
    applicantNotification = await sendEmail({
      to: finalizedProfile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Application Received - AssembleAtEase',
      html: buildApplicantEmail(String(finalizedProfile.full_name || '').split(' ')[0], {
        feeWaived: finalizedFeeWaived,
        verificationResumeUrl,
      }),
      replyTo: ownerEmail(),
      meta: {
        notificationType: 'easer_application_received',
        recipientType: 'easer',
        recipientUserId: userId,
        disableDedupe: true,
      },
    });
  } catch (error) {
    console.error('Applicant application email error:', error);
    applicantNotification = { ok: false, error: error?.message || String(error) };
  }

  const ownerDelivered = ownerNotification?.ok === true && !ownerNotification?.suppressed;
  const applicantDelivered = applicantNotification?.ok === true && !applicantNotification?.suppressed;
  return applicationSuccessResponse(finalizedProfile, {
    ownerDelivered,
    applicantDelivered,
    warning: applicantDelivered
      ? null
      : 'Application saved, but the secure verification email could not be delivered. Contact support for a new link.',
  });
}

function paidApplicationFeeResponse() {
  return {
    amountCents: EASER_APPLICATION_FEE_CENTS,
    amountDisplay: EASER_APPLICATION_FEE_DISPLAY,
    currency: EASER_APPLICATION_FEE_CURRENCY,
    waived: false,
    paid: false,
  };
}

function applicationSuccessResponse(profile, {
  alreadyFinalized = false,
  ownerDelivered,
  applicantDelivered,
  warning = null,
} = {}) {
  const feeWaived = profile.application_fee_waived === true || profile.fee_waived_by_owner === true;
  const response = {
    success: true,
    alreadyFinalized,
    feeWaived,
    foundingProgram: profile.founding_easer === true,
    applicationFee: {
      amountCents: feeWaived ? 0 : EASER_APPLICATION_FEE_CENTS,
      amountDisplay: feeWaived ? '$0.00' : EASER_APPLICATION_FEE_DISPLAY,
      currency: EASER_APPLICATION_FEE_CURRENCY,
      waived: feeWaived,
      foundingNumber: profile.founding_easer_number || null,
      paid: profile.application_fee_paid === true,
    },
    warning,
  };
  if (typeof ownerDelivered === 'boolean' || typeof applicantDelivered === 'boolean') {
    response.notifications = { ownerDelivered: ownerDelivered === true, applicantDelivered: applicantDelivered === true };
  }
  return response;
}

async function cleanupFreshApplicant(sb, userId, { deleteAuth = true } = {}) {
  if (!userId) return;
  const { error: profileDeleteError } = await sb.from('profiles').delete().eq('id', userId);
  if (profileDeleteError) {
    console.error('Fresh applicant profile cleanup failed:', profileDeleteError.message || profileDeleteError);
  }
  if (deleteAuth) {
    const { error: authDeleteError } = await sb.auth.admin.deleteUser(userId);
    if (authDeleteError) console.error('Fresh applicant auth cleanup failed:', authDeleteError.message || authDeleteError);
  }
}

async function findAuthUserByEmail(sb, email) {
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const match = users.find(user => String(user.email || '').toLowerCase() === email);
    if (match) return match;
    if (users.length < 200) return null;
  }
  return null;
}

function buildOwnerEmail({ cleanName, cleanEmail, cleanPhone, city, state, zip, yearsExperience, hasTools, hasTransport, bio, servicesList, paymentIntentId, feeWaived, foundingNumber, verificationResumeUrl }) {
  const paymentLine = feeWaived
    ? `&#10003; Founding Easer application &bull; ${EASER_APPLICATION_FEE_DISPLAY} fee waived${foundingNumber ? ` &bull; Founding #${foundingNumber}` : ''}`
    : `&#10003; ${EASER_APPLICATION_FEE_DISPLAY} application fee paid`;
  const verificationLine = verificationResumeUrl ? ' &bull; Time-limited identity-verification link sent' : ' &bull; Identity verification follow-up needed';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:3px solid #00BFFF"><tr><td style="padding:20px 24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="36" height="36" style="border-radius:50%;display:block"/></td>
      <td style="padding-left:12px;font-size:16px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
  </td><td style="padding:20px 24px;text-align:right;font-size:12px;color:#71717a">New Application</td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 4px;font-size:20px;font-weight:700;color:#1a1a1a">New Assembler Application</p>
    <p style="margin:0 0 20px;font-size:13px;color:#71717a">${esc(cleanName)} wants to join the team</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;width:140px">Name</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;font-weight:600">${esc(cleanName)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Email</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(cleanEmail)}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(formatUsPhone(cleanPhone) || 'Unavailable')}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Location</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${esc(String(city || '').trim())}, ${esc(String(state || '').trim())} ${esc(String(zip || '').trim())}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Experience</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${parseInt(yearsExperience,10)} year(s)</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Own tools</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTools ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a">Transportation</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0">${hasTransport ? 'Yes' : 'No'}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #f0f0f0;color:#71717a;vertical-align:top">Services</td><td style="padding:8px 0;border-bottom:1px solid #f0f0f0"><ul style="margin:0;padding-left:16px">${servicesList}</ul></td></tr>
      <tr><td style="padding:8px 0;color:#71717a;vertical-align:top">About</td><td style="padding:8px 0">${esc(bio?.trim() || 'Not provided')}</td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">${paymentLine}${verificationLine}</p>
      ${paymentIntentId ? `<p style="margin:4px 0 0;font-size:12px;color:#15803d">Stripe Payment ID: ${esc(paymentIntentId)}</p>` : ''}
    </td></tr></table>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX
  </td></tr></table>
</div></body></html>`;
}

function buildApplicantEmail(firstName, { feeWaived, verificationResumeUrl }) {
  const paymentCopy = feeWaived
    ? 'Your Founding Easer application was submitted with no application fee collected.'
    : `Your ${EASER_APPLICATION_FEE_DISPLAY} application fee has been received.`;
  const statusCopy = verificationResumeUrl
    ? '&#10003; Application submitted &bull; Identity verification required'
    : '&#10003; Application submitted &bull; Identity verification follow-up required';
  const verificationBlock = verificationResumeUrl ? `
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:#00BFFF;border-radius:8px">
      <a href="${esc(verificationResumeUrl)}" style="display:inline-block;padding:13px 28px;color:#001f2b;font-size:14px;font-weight:800;text-decoration:none;border-radius:8px">Continue Identity Verification</a>
    </td></tr></table>
    <p style="margin:0 0 18px;font-size:13px;color:#52525b;line-height:1.7">This secure link is time-limited. If Stripe requires another attempt, AssembleAtEase will email you a new link.</p>`
    : `<p style="margin:0 0 18px;font-size:13px;color:#92400e;line-height:1.7">Identity verification is temporarily unavailable. Reply to this email if you need help completing your application.</p>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Application received, ${esc(firstName)}!</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">Thank you for applying to join the AssembleAtEase team. ${paymentCopy} Your application is now on file, but we cannot review or approve it until identity verification is completed.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px;text-align:center">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:600">${statusCopy}</p>
    </td></tr></table>
    ${verificationBlock}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <ol style="margin:8px 0 0;padding-left:16px;font-size:14px;color:#52525b;line-height:1.8">
        <li>Complete identity verification through the secure AssembleAtEase link above.</li>
        <li>Our team reviews your application after Stripe confirms your identity check.</li>
        <li>If approved, you receive a separate email with password setup and dashboard access.</li>
      </ol>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">
    AssembleAtEase &bull; Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a">service@assembleatease.com</a>
  </td></tr></table>
</div></body></html>`;
}
