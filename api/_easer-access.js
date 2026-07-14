import { createClient } from '@supabase/supabase-js';
import { getSupabase } from './_supabase.js';
import { ACTIVE_EASER_TIERS, normalizeAssemblerTier } from './_assembler-state.js';
import {
  hasEaserApplicationFeeRefundHold,
  isApplicationFeeSatisfied,
} from './_easer-application-fee.js';
import { isEaserClosureBlocking } from './_easer-closure.js';

function bearerToken(req) {
  const authorization = String(req?.headers?.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function hasActiveApprovedWorkCredentials(profile = {}) {
  return Boolean(
    profile.role === 'assembler'
    && String(profile.status || '').trim().toLowerCase() === 'active'
    && String(profile.application_status || '').trim().toLowerCase() === 'approved'
    && ACTIVE_EASER_TIERS.includes(normalizeAssemblerTier(profile.tier))
    && profile.identity_verified === true
    && Boolean(profile.contractor_agreement_signed_at)
    && Boolean(profile.code_of_conduct_agreed_at)
    && !isEaserClosureBlocking(profile)
  );
}

export function isActiveApprovedEaserProfile(profile = {}) {
  return hasActiveApprovedWorkCredentials(profile)
    && isApplicationFeeSatisfied(profile);
}

/**
 * A refund-held Easer may finish only work that is already assigned to them.
 * Every route using this predicate must separately prove booking.assembler_id.
 * It never grants offer, acceptance, membership, or new-job access.
 */
export function isAssignedWorkEaserProfile(profile = {}) {
  const paidRefundHold = profile.application_fee_paid === true
    && profile.payment_confirmed === true
    && hasEaserApplicationFeeRefundHold(profile);
  return hasActiveApprovedWorkCredentials(profile)
    && (
      isApplicationFeeSatisfied(profile)
      || paidRefundHold
    );
}

export async function authenticateBearerUser(req, options = {}) {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'Unauthorized' };

  const authClient = options.authClient || createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
  );
  try {
    const { data: { user } = {}, error } = await authClient.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid or expired session' };
    return { ok: true, user, token };
  } catch (error) {
    console.error('Bearer authentication service failed:', error?.message || error);
    return { ok: false, status: 503, error: 'Authentication could not be verified. Please try again.' };
  }
}

/**
 * Canonical authorization guard for authenticated Easer job APIs.
 * Availability is intentionally not required: an Easer who goes offline must
 * still be able to safely finish or review an already assigned job.
 */
const EASER_ACCESS_PROFILE_PROJECTION = 'id, role, status, application_status, tier, has_membership, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, application_fee_paid, payment_confirmed, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status';

async function requireEaserProfile(req, options, predicate, deniedMessage) {
  const authenticated = await authenticateBearerUser(req, options);
  if (!authenticated.ok) return authenticated;

  const sb = options.supabase || getSupabase();
  let profile;
  let error;
  try {
    const result = await sb
      .from('profiles')
      .select(EASER_ACCESS_PROFILE_PROJECTION)
      .eq('id', authenticated.user.id)
      .maybeSingle();
    profile = result.data;
    error = result.error;
  } catch (lookupError) {
    error = lookupError;
  }

  if (error) {
    console.error('Easer authorization profile lookup failed:', error.message || error);
    return { ok: false, status: 503, error: 'Easer access could not be verified. Please try again.' };
  }
  if (!profile || !predicate(profile)) {
    return { ok: false, status: 403, error: deniedMessage };
  }

  return {
    ...authenticated,
    profile,
    sb,
    applicationFeeRefundHold: hasEaserApplicationFeeRefundHold(profile),
  };
}

export async function requireActiveApprovedEaser(req, options = {}) {
  return requireEaserProfile(
    req,
    options,
    isActiveApprovedEaserProfile,
    'An active, approved Easer account is required.',
  );
}

export async function requireAssignedWorkEaser(req, options = {}) {
  return requireEaserProfile(
    req,
    options,
    isAssignedWorkEaserProfile,
    'An active, approved Easer account with assigned-work access is required.',
  );
}

export function respondWithEaserAccessError(res, access) {
  return res.status(access?.status || 403).json({
    error: access?.error || 'Easer access denied',
  });
}
