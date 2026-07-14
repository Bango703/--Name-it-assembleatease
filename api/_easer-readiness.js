import Stripe from 'stripe';
import { ACTIVE_EASER_TIERS, normalizeAssemblerTier } from './_assembler-state.js';
import { CONTRACTOR_AGREEMENT_VERSION } from './_assembler-onboarding.js';
import { isStripeConnectEnabled } from './_stripe-connect.js';
import { isApplicationFeeSatisfied } from './_easer-application-fee.js';
import { isEaserClosureBlocking, normalizeEaserClosureStatus } from './_easer-closure.js';
import { normalizeUsPhone } from './_phone.js';

export { isApplicationFeeSatisfied } from './_easer-application-fee.js';

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

function connectState(profile, account, verificationError) {
  const requirements = account?.requirements || {};
  const currentlyDue = Array.isArray(requirements.currently_due) ? requirements.currently_due : [];
  const pastDue = Array.isArray(requirements.past_due) ? requirements.past_due : [];
  const disabledReason = requirements.disabled_reason || null;

  return {
    connectStarted: !!profile?.stripe_connect_account_id,
    connectVerified: !!account && !verificationError,
    connectComplete: !!(
      account?.details_submitted
      && account?.charges_enabled
      && account?.payouts_enabled
    ),
    payoutsEnabled: account?.payouts_enabled === true,
    chargesEnabled: account?.charges_enabled === true,
    requirementsDueCount: currentlyDue.length + pastDue.length,
    disabledReason,
    verificationError: verificationError || null,
  };
}

/**
 * One source of truth for whether an Easer may receive or accept jobs.
 * Manual payout mode intentionally ignores Stripe Connect. Connect mode fails
 * closed unless the connected account is verified live and has no blockers.
 */
export async function getEaserReadiness(profile = {}, options = {}) {
  const connectRequired = options.connectRequired ?? isStripeConnectEnabled();
  const requireAvailability = options.requireAvailability !== false;
  const tier = normalizeAssemblerTier(profile.tier);
  const applicationStatus = clean(profile.application_status);
  const accountClosureStatus = normalizeEaserClosureStatus(profile);
  const applicationFeeStatusKnown = [
    'application_fee_paid',
    'application_fee_waived',
    'fee_waived_by_owner',
  ].some(field => Object.prototype.hasOwnProperty.call(profile, field));

  const flags = {
    connectRequired,
    applicationSubmitted: ['applied', 'approved'].includes(applicationStatus),
    contractorAgreementAccepted: !!profile.contractor_agreement_signed_at,
    codeOfConductAccepted: !!profile.code_of_conduct_agreed_at,
    agreementVersion: profile.contractor_agreement_version || null,
    agreementCurrent: (
      !!profile.contractor_agreement_signed_at
      && profile.contractor_agreement_version === CONTRACTOR_AGREEMENT_VERSION
    ),
    identityVerified: profile.identity_verified === true,
    ownerApproved: clean(profile.status) === 'active' && applicationStatus === 'approved',
    tierEligible: ACTIVE_EASER_TIERS.includes(tier),
    available: profile.is_available === true,
    phoneAvailable: normalizeUsPhone(profile.phone) !== null,
    applicationFeeStatusKnown,
    applicationFeeSatisfied: isApplicationFeeSatisfied(profile),
    accountClosureStatus,
    accountClosureBlocking: isEaserClosureBlocking(accountClosureStatus),
  };

  let account = options.stripeAccount;
  let verificationError = null;

  if (connectRequired && account === undefined) {
    if (!profile.stripe_connect_account_id) {
      account = null;
    } else if (!process.env.STRIPE_SECRET_KEY && !options.stripeClient) {
      verificationError = 'Stripe Connect cannot be verified because Stripe is not configured';
      account = null;
    } else {
      try {
        const stripe = options.stripeClient || new Stripe(process.env.STRIPE_SECRET_KEY);
        account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
      } catch (err) {
        verificationError = err?.message || 'Stripe Connect verification failed';
        account = null;
      }
    }
  }

  const connect = connectState(profile, account, verificationError);
  const missingItems = [];

  if (!flags.applicationSubmitted) missingItems.push('Application submitted');
  if (flags.accountClosureBlocking) {
    missingItems.push(`Account closure ${flags.accountClosureStatus}`);
  }
  // Explicit profile reads (owner approval/readiness) must prove paid-or-waived.
  // A few legacy dispatch projections do not yet select these columns; the
  // database transition trigger in migration 034 still blocks new unpaid
  // profiles from becoming active/approved/available.
  if (flags.applicationFeeStatusKnown && !flags.applicationFeeSatisfied) {
    missingItems.push('Application fee paid or explicitly waived');
  }
  if (!flags.contractorAgreementAccepted) missingItems.push('Contractor agreement accepted');
  if (flags.contractorAgreementAccepted && !flags.agreementCurrent) {
    missingItems.push(`Current contractor agreement accepted (${CONTRACTOR_AGREEMENT_VERSION})`);
  }
  if (!flags.codeOfConductAccepted) missingItems.push('Code of conduct accepted');
  if (!flags.identityVerified) missingItems.push('Identity verified');
  if (!flags.ownerApproved) missingItems.push('Owner approved');
  if (!flags.tierEligible) missingItems.push('Valid Easer tier');
  if (!flags.phoneAvailable) missingItems.push('Valid 10-digit U.S. phone number on file');
  if (requireAvailability && !flags.available) missingItems.push('Online and available');

  if (connectRequired) {
    if (!connect.connectStarted) missingItems.push('Stripe Connect started');
    if (!connect.connectVerified) missingItems.push('Stripe Connect status verified');
    if (!connect.connectComplete) missingItems.push('Stripe Connect complete');
    if (!connect.payoutsEnabled) missingItems.push('Stripe payouts enabled');
    if (connect.requirementsDueCount > 0) {
      missingItems.push(`Stripe requirements due: ${connect.requirementsDueCount}`);
    }
    if (connect.disabledReason) missingItems.push(`Stripe disabled reason: ${connect.disabledReason}`);
  }

  return {
    ...flags,
    ...connect,
    tier,
    currentAgreementVersion: CONTRACTOR_AGREEMENT_VERSION,
    missingItems,
    isReady: missingItems.length === 0,
    finalStatus: missingItems.length === 0 ? 'READY FOR JOBS' : 'ACTION REQUIRED',
  };
}

export function readinessError(readiness) {
  if (readiness?.isReady) return null;
  const missing = readiness?.missingItems || [];
  return `Easer is not ready for jobs: ${missing.join(', ') || 'readiness could not be verified'}.`;
}
