import Stripe from 'stripe';
import { randomUUID } from 'crypto';

export const SITE = 'https://www.assembleatease.com';
export const CONTRACTOR_AGREEMENT_VERSION = '2026-07-12';

export function buildIdentityResumeUrl(resumeToken) {
  return `${SITE}/assembler/verify-identity?token=${encodeURIComponent(String(resumeToken || '').trim())}`;
}

export async function ensureIdentityResumeToken(sb, profile) {
  const existing = String(profile?.identity_resume_token || '').trim();
  if (existing) return existing;

  const resumeToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const createdAt = new Date().toISOString();

  const { error } = await sb.from('profiles').update({
    identity_resume_token: resumeToken,
    identity_resume_token_created_at: createdAt,
  }).eq('id', profile.id);

  if (error) throw error;
  return resumeToken;
}

export async function bestEffortProfileUpdate(sb, profileId, updates) {
  if (!profileId || !updates || !Object.keys(updates).length) return;
  try {
    const { error } = await sb.from('profiles').update(updates).eq('id', profileId);
    if (error) throw error;
  } catch (err) {
    console.warn('Assembler onboarding profile update skipped:', err?.message || err);
  }
}

export async function createIdentityVerificationSession(sb, { profileId, resumeToken = null } = {}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const returnUrl = new URL('/assembler/verify-identity', SITE);
  if (resumeToken) returnUrl.searchParams.set('token', resumeToken);
  returnUrl.searchParams.set('verification', 'complete');

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

  await bestEffortProfileUpdate(sb, profileId, {
    stripe_verification_id: session.id,
    stripe_identity_session_id: session.id,
    id_verification_status: 'pending',
    identity_verified: false,
  });

  return {
    sessionId: session.id,
    verificationUrl: session.url,
  };
}

export async function recordAgreementAcceptance(sb, {
  profileId,
  signedName,
  agreementIp,
  agreementUserAgent,
}) {
  const acceptedAt = new Date().toISOString();
  await bestEffortProfileUpdate(sb, profileId, {
    code_of_conduct_agreed_at: acceptedAt,
    contractor_agreement_signed_at: acceptedAt,
    contractor_agreement_version: CONTRACTOR_AGREEMENT_VERSION,
    contractor_agreement_ip: String(agreementIp || 'unknown').slice(0, 120),
    contractor_agreement_user_agent: String(agreementUserAgent || '').slice(0, 500) || null,
    contractor_agreement_signed_name: signedName || null,
  });

  return {
    acceptedAt,
    agreementVersion: CONTRACTOR_AGREEMENT_VERSION,
  };
}

export function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req?.headers?.['x-real-ip'] || '').trim();
  const cfIp = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  return (forwarded || realIp || cfIp || req?.socket?.remoteAddress || 'unknown').slice(0, 120);
}
