import Stripe from 'stripe';
import { createPersonaInquiry, generatePersonaLink, identityProvider, personaInquiryResumable, retrievePersonaInquiry } from './_persona.js';
import { randomBytes } from 'crypto';

export const SITE = 'https://www.assembleatease.com';
export const CONTRACTOR_AGREEMENT_VERSION = '2026-10-18';
// Applications still open for a decision. A waitlisted application is a
// decision about a submitted application, not a withdrawal of it, so the owner
// can still finish its onboarding (the same set api/_easer-readiness.js treats
// as submitted; scripts/test-onboarding-open-applications.mjs keeps them equal).
export const OPEN_APPLICATION_STATUSES = Object.freeze(['applied', 'waitlist']);

const configuredResumeHours = Number.parseInt(process.env.IDENTITY_RESUME_TOKEN_TTL_HOURS || '72', 10);
export const IDENTITY_RESUME_TOKEN_TTL_MS = Math.min(
  7 * 24 * 60 * 60 * 1000,
  Math.max(60 * 60 * 1000, (Number.isFinite(configuredResumeHours) ? configuredResumeHours : 72) * 60 * 60 * 1000),
);

export function buildIdentityResumeUrl(resumeToken) {
  const token = String(resumeToken || '').trim();
  if (!token) throw new Error('Identity resume token is required');
  return `${SITE}/assembler/verify-identity?token=${encodeURIComponent(token)}`;
}

export function isIdentityResumeTokenValid(profile, now = Date.now()) {
  const token = String(profile?.identity_resume_token || '').trim();
  const expiresAt = Date.parse(profile?.identity_resume_token_expires_at || '');
  return Boolean(token && Number.isFinite(expiresAt) && expiresAt > Number(now));
}

function newIdentityResumeTokenValues() {
  const resumeToken = randomBytes(48).toString('hex');
  const createdAt = new Date();
  return {
    resumeToken,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + IDENTITY_RESUME_TOKEN_TTL_MS),
  };
}

export async function updateProfileRequired(sb, profileId, updates, context = 'profile update') {
  if (!profileId || !updates || !Object.keys(updates).length) {
    throw new Error(`${context} is missing required data`);
  }

  const { data, error } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', profileId)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`${context} failed: ${error.message || error}`);
  if (!data?.id) throw new Error(`${context} failed: Easer profile not found`);
  return data;
}

export async function rotateIdentityResumeToken(sb, profileId, options = {}) {
  if (!profileId) throw new Error('Identity resume token rotation is missing the Easer profile');
  const { resumeToken, createdAt, expiresAt } = newIdentityResumeTokenValues();

  let query = sb.from('profiles').update({
    identity_resume_token: resumeToken,
    identity_resume_token_created_at: createdAt.toISOString(),
    identity_resume_token_expires_at: expiresAt.toISOString(),
  }).eq('id', profileId);
  if (options.expectedToken) {
    query = query.eq('identity_resume_token', String(options.expectedToken));
    if (!options.allowExpiredExpected) {
      query = query.gt('identity_resume_token_expires_at', createdAt.toISOString());
    }
  } else if (options.expectNoToken) {
    query = query.is('identity_resume_token', null);
  }
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(`Identity resume token rotation failed: ${error.message || error}`);
  if (!data?.id) {
    throw new Error(options.expectedToken || options.expectNoToken
      ? 'Identity verification link was already used or expired'
      : 'Identity resume token rotation failed: Easer profile not found');
  }

  return resumeToken;
}

export async function ensureIdentityResumeToken(sb, profile, options = {}) {
  if (!options.rotate && isIdentityResumeTokenValid(profile)) {
    return String(profile.identity_resume_token).trim();
  }
  return rotateIdentityResumeToken(sb, profile?.id);
}

export async function clearIdentityResumeToken(sb, profileId) {
  await updateProfileRequired(sb, profileId, {
    identity_resume_token: null,
    identity_resume_token_created_at: null,
    identity_resume_token_expires_at: null,
  }, 'Identity resume token revocation');
}

export async function restoreIdentityResumeTokenAfterFailedStart(sb, profileId, {
  expectedToken,
  priorToken,
} = {}) {
  if (!profileId || !expectedToken || !priorToken) {
    throw new Error('Identity resume token restoration is missing required data');
  }
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + IDENTITY_RESUME_TOKEN_TTL_MS);
  const { data, error } = await sb.from('profiles').update({
    identity_resume_token: String(priorToken),
    identity_resume_token_created_at: createdAt.toISOString(),
    identity_resume_token_expires_at: expiresAt.toISOString(),
  })
    .eq('id', profileId)
    .eq('identity_resume_token', String(expectedToken))
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Identity resume token restoration failed: ${error.message || error}`);
  if (!data?.id) throw new Error('Identity resume token restoration lost a concurrent update');
}

/**
 * Start (or resume) the applicant's ID check and return the hosted link.
 * Persona when it is chosen and configured (api/_persona.js), otherwise Stripe
 * Identity. If Persona fails for any reason (outage, missing migration 133, bad
 * key) the applicant gets a working Stripe check instead of an error: our
 * failure must never become their extra step (Rule 16, Article 13).
 */
export async function createIdentityVerificationSession(sb, { profileId, resumeToken = null } = {}) {
  const returnUrl = new URL('/assembler/verify-identity', SITE);
  if (resumeToken) returnUrl.searchParams.set('token', resumeToken);
  returnUrl.searchParams.set('verification', 'complete');

  if (identityProvider() === 'persona') {
    try {
      return await createPersonaVerification(sb, { profileId, redirectUri: returnUrl.toString() });
    } catch (error) {
      console.error('[identity] Persona unavailable, using Stripe Identity:', error?.message || error);
    }
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const session = await stripe.identity.verificationSessions.create({
    type: 'document',
    options: {
      document: {
        require_live_capture: true,
        require_matching_selfie: true,
        allowed_types: ['driving_license', 'id_card', 'passport'],
      },
    },
    metadata: { userId: profileId },
    return_url: returnUrl.toString(),
  });

  await updateProfileRequired(sb, profileId, {
    stripe_verification_id: session.id,
    stripe_identity_session_id: session.id,
    id_verification_status: 'pending',
    identity_verified: false,
  }, 'Identity verification session persistence');
  // Which provider holds the current check. Best-effort: before migration 133
  // the column does not exist, and that must never block a Stripe check.
  try { await sb.from('profiles').update({ identity_provider: 'stripe' }).eq('id', profileId); } catch { /* column not migrated yet */ }

  return {
    sessionId: session.id,
    verificationUrl: session.url,
    provider: 'stripe',
  };
}

/**
 * Persona: reuse the applicant's open inquiry when it can still be finished,
 * otherwise create one, then hand back a fresh one-time link. Throws on any
 * failure so the caller falls back to Stripe.
 */
async function createPersonaVerification(sb, { profileId, redirectUri }) {
  const { data: refs, error } = await sb.from('profiles')
    .select('persona_inquiry_id, full_name, email')
    .eq('id', profileId)
    .maybeSingle();
  if (error) throw new Error(`Persona reference lookup failed: ${error.message || error}`);

  let inquiryId = refs?.persona_inquiry_id || null;
  if (inquiryId) {
    try {
      const existing = await retrievePersonaInquiry(inquiryId);
      if (!personaInquiryResumable(existing.status)) inquiryId = null;
    } catch {
      inquiryId = null;
    }
  }
  if (!inquiryId) {
    const [nameFirst, ...rest] = String(refs?.full_name || '').trim().split(/\s+/).filter(Boolean);
    const created = await createPersonaInquiry({
      profileId,
      redirectUri,
      nameFirst,
      nameLast: rest.join(' ') || undefined,
      email: refs?.email || undefined,
    });
    inquiryId = created.id;
    if (!inquiryId) throw new Error('Persona returned no inquiry id');
  }

  const verificationUrl = await generatePersonaLink(inquiryId);
  await updateProfileRequired(sb, profileId, {
    persona_inquiry_id: inquiryId,
    identity_provider: 'persona',
    id_verification_status: 'pending',
    identity_verified: false,
  }, 'Persona inquiry persistence');

  return { sessionId: inquiryId, verificationUrl, provider: 'persona' };
}

export async function recordAgreementAcceptance(sb, {
  profileId,
  signedName,
  agreementIp,
  agreementUserAgent,
  rotateResumeToken = false,
  expectedResumeToken = null,
}) {
  const acceptedAt = new Date().toISOString();
  const updates = {
    code_of_conduct_agreed_at: acceptedAt,
    contractor_agreement_signed_at: acceptedAt,
    contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
    contractor_agreement_ip: String(agreementIp || 'unknown').slice(0, 120),
    contractor_agreement_user_agent: String(agreementUserAgent || '').slice(0, 500) || null,
    contractor_agreement_signed_name: signedName || null,
  };

  let resumeToken = null;
  if (rotateResumeToken) {
    const tokenValues = newIdentityResumeTokenValues();
    resumeToken = tokenValues.resumeToken;
    Object.assign(updates, {
      identity_resume_token: resumeToken,
      identity_resume_token_created_at: tokenValues.createdAt.toISOString(),
      identity_resume_token_expires_at: tokenValues.expiresAt.toISOString(),
    });

    let query = sb.from('profiles').update(updates).eq('id', profileId);
    if (expectedResumeToken) {
      query = query
        .eq('identity_resume_token', String(expectedResumeToken))
        .gt('identity_resume_token_expires_at', tokenValues.createdAt.toISOString());
    }
    const { data, error } = await query.select('id').maybeSingle();
    if (error) throw new Error(`Contractor agreement acceptance failed: ${error.message || error}`);
    if (!data?.id) {
      throw new Error(expectedResumeToken
        ? 'Identity verification link was already used or expired'
        : 'Contractor agreement acceptance failed: Easer profile not found');
    }
  } else {
    await updateProfileRequired(sb, profileId, updates, 'Contractor agreement acceptance');
  }

  return {
    acceptedAt,
    agreementVersion: CONTRACTOR_AGREEMENT_VERSION,
    resumeToken,
  };
}

export function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  const cfIp = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  return (forwarded || realIp || cfIp || req?.socket?.remoteAddress || 'unknown').slice(0, 120);
}
