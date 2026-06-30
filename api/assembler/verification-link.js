import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import {
  buildIdentityResumeUrl,
  createIdentityVerificationSession,
  ensureIdentityResumeToken,
  getClientIp,
  recordAgreementAcceptance,
} from '../_assembler-onboarding.js';

async function resolveAssemblerProfile(req, sb) {
  const resumeToken = String(req.query?.token || req.body?.token || '').trim();
  const auth = req.headers.authorization;

  if (auth && auth.startsWith('Bearer ')) {
    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await userClient.auth.getUser(auth.slice(7));
    if (authError || !user) {
      return { error: 'Invalid or expired session', status: 401 };
    }

    const { data: profile, error } = await sb
      .from('profiles')
      .select('id, role, full_name, email, status, application_status, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, identity_resume_token')
      .eq('id', user.id)
      .maybeSingle();

    if (error || !profile) return { error: 'Profile not found', status: 404 };
    if (profile.role !== 'assembler') return { error: 'Only Easers can use this endpoint', status: 403 };
    return { profile, authMode: 'session', resumeToken: profile.identity_resume_token || null };
  }

  if (!resumeToken) {
    return { error: 'Verification token is required', status: 400 };
  }

  if (!await rateLimit(getClientIp(req), 'default')) {
    return { error: 'Too many requests. Please try again in a moment.', status: 429 };
  }

  const { data: profile, error } = await sb
    .from('profiles')
    .select('id, role, full_name, email, status, application_status, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, identity_resume_token')
    .eq('identity_resume_token', resumeToken)
    .maybeSingle();

  if (error || !profile) return { error: 'This verification link is invalid or has expired.', status: 404 };
  if (profile.role !== 'assembler') return { error: 'Verification link is not valid for this account.', status: 403 };
  return { profile, authMode: 'token', resumeToken };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = getSupabase();
  const resolved = await resolveAssemblerProfile(req, sb);
  if (resolved.error) {
    return res.status(resolved.status || 400).json({ error: resolved.error });
  }

  const { profile, authMode } = resolved;
  const resumeToken = resolved.resumeToken || await ensureIdentityResumeToken(sb, profile);
  const resumeUrl = buildIdentityResumeUrl(resumeToken);
  const rejected = String(profile.status || profile.application_status || '').toLowerCase() === 'rejected';
  if (rejected) {
    return res.status(403).json({ error: 'This application is no longer active.' });
  }

  if (req.method === 'GET') {
    const requiresAgreement = !profile.contractor_agreement_signed_at || !profile.code_of_conduct_agreed_at;
    return res.status(200).json({
      ok: true,
      authMode,
      fullName: profile.full_name || '',
      identityVerified: profile.identity_verified === true,
      applicationStatus: profile.application_status || null,
      requiresAgreement,
      agreementPendingOnly: profile.identity_verified === true && requiresAgreement,
      resumeUrl,
    });
  }

  const requiresAgreement = !profile.contractor_agreement_signed_at || !profile.code_of_conduct_agreed_at;
  if (profile.identity_verified === true && !requiresAgreement) {
    return res.status(200).json({
      ok: true,
      alreadyVerified: true,
      resumeUrl,
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const signedName = String(body.fullName || profile.full_name || '').trim();

  if (requiresAgreement) {
    if (signedName.split(/\s+/).filter(Boolean).length < 2) {
      return res.status(400).json({ error: 'Enter your full legal name before continuing.' });
    }
    if (body.contractorAgreementSigned !== true) {
      return res.status(400).json({ error: 'You must accept the contractor agreement before continuing.' });
    }
    if (body.codeOfConductAccepted !== true) {
      return res.status(400).json({ error: 'You must accept the code of conduct before continuing.' });
    }

    await recordAgreementAcceptance(sb, {
      profileId: profile.id,
      signedName,
      agreementIp: getClientIp(req),
      agreementUserAgent: req.headers['user-agent'],
    });

    if (profile.identity_verified === true) {
      return res.status(200).json({
        ok: true,
        alreadyVerified: true,
        agreementRecorded: true,
        resumeUrl,
      });
    }
  }

  try {
    const session = await createIdentityVerificationSession(sb, {
      profileId: profile.id,
      resumeToken,
    });

    return res.status(200).json({
      ok: true,
      verificationUrl: session.verificationUrl,
      resumeUrl,
    });
  } catch (err) {
    console.error('verification-link session error:', err?.message || err);
    return res.status(503).json({
      error: 'Identity verification is temporarily unavailable. Please try again shortly.',
    });
  }
}
