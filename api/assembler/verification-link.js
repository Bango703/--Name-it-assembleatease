import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { esc, ownerEmail, sendEmail } from '../_email.js';
import {
  buildIdentityResumeUrl,
  clearIdentityResumeToken,
  CONTRACTOR_AGREEMENT_VERSION,
  createIdentityVerificationSession,
  ensureIdentityResumeToken,
  getClientIp,
  isIdentityResumeTokenValid,
  recordAgreementAcceptance,
  restoreIdentityResumeTokenAfterFailedStart,
  rotateIdentityResumeToken,
} from '../_assembler-onboarding.js';

function isEstablishedEaser(profile = {}) {
  return String(profile.status || '').trim().toLowerCase() === 'active'
    && String(profile.application_status || '').trim().toLowerCase() === 'approved';
}

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
      .select('id, role, full_name, email, status, application_status, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, contractor_agreement_version, identity_resume_token, identity_resume_token_created_at, identity_resume_token_expires_at')
      .eq('id', user.id)
      .maybeSingle();

    if (error || !profile) return { error: 'Profile not found', status: 404 };
    if (profile.role !== 'assembler') return { error: 'Only Easers can use this endpoint', status: 403 };
    return { profile, authMode: 'session', resumeToken: profile.identity_resume_token || null };
  }

  if (!resumeToken) {
    return { error: 'Verification token is required', status: 400 };
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(resumeToken)) {
    return { error: 'This verification link is invalid or has expired.', status: 404 };
  }

  if (!await rateLimit(getClientIp(req), 'default')) {
    return { error: 'Too many requests. Please try again in a moment.', status: 429 };
  }

  const { data: profile, error } = await sb
    .from('profiles')
    .select('id, role, full_name, email, status, application_status, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, contractor_agreement_version, identity_resume_token, identity_resume_token_created_at, identity_resume_token_expires_at')
    .eq('identity_resume_token', resumeToken)
    .maybeSingle();

  if (error || !profile) return { error: 'This verification link is invalid or has expired.', status: 404 };
  if (profile.role !== 'assembler') return { error: 'Verification link is not valid for this account.', status: 403 };
  if (!isIdentityResumeTokenValid(profile)) {
    let replacementSent = false;
    try {
      const replacementToken = await rotateIdentityResumeToken(sb, profile.id, {
        expectedToken: resumeToken,
        allowExpiredExpected: true,
      });
      const replacementUrl = buildIdentityResumeUrl(replacementToken);
      const delivery = await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Your New Secure Easer Verification Link',
        replyTo: ownerEmail(),
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px"><h2 style="color:#00BFFF">New secure verification link</h2><p>Hi ${esc((profile.full_name || 'there').split(' ')[0])},</p><p>Your previous secure link expired. Use the new time-limited link below to continue the verification or agreement step required for your AssembleAtEase Easer account.</p><p><a href="${esc(replacementUrl)}" style="color:#00BFFF;font-weight:700">Continue account verification</a></p><p>If you did not request this, contact AssembleAtEase support.</p></div>`,
        meta: {
          notificationType: 'identity_resume_link_reissued',
          recipientType: 'easer',
          recipientUserId: profile.id,
        },
      });
      replacementSent = delivery?.ok === true && !delivery?.suppressed;
    } catch (replacementError) {
      console.error('verification-link replacement delivery failed:', replacementError?.message || replacementError);
    }
    return {
      error: replacementSent
        ? 'This verification link expired. A new secure link was sent to the application email.'
        : 'This verification link expired. Contact support for a new link.',
      status: 410,
      replacementSent,
    };
  }
  return { profile, authMode: 'token', resumeToken };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = getSupabase();
  const resolved = await resolveAssemblerProfile(req, sb);
  if (resolved.error) {
    return res.status(resolved.status || 400).json({
      error: resolved.error,
      replacementSent: resolved.replacementSent === true || undefined,
    });
  }

  const { profile, authMode } = resolved;
  const inactiveApplication = [profile.status, profile.application_status]
    .map(value => String(value || '').trim().toLowerCase())
    .some(value => ['rejected', 'suspended', 'archived'].includes(value));
  if (inactiveApplication) {
    return res.status(403).json({ error: 'This application is no longer active.' });
  }
  let resumeToken;
  let resumeUrl;
  try {
    resumeToken = resolved.resumeToken || await ensureIdentityResumeToken(sb, profile);
    resumeUrl = buildIdentityResumeUrl(resumeToken);
  } catch (err) {
    console.error('verification-link token persistence error:', err?.message || err);
    return res.status(503).json({ error: 'A secure verification link could not be prepared. Please try again.' });
  }

  if (req.method === 'GET') {
    const requiresAgreement = !profile.contractor_agreement_signed_at
      || !profile.code_of_conduct_agreed_at
      || profile.contractor_agreement_version !== CONTRACTOR_AGREEMENT_VERSION;
    const establishedEaser = isEstablishedEaser(profile);
    return res.status(200).json({
      ok: true,
      authMode,
      fullName: profile.full_name || '',
      identityVerified: profile.identity_verified === true,
      accountStatus: profile.status || null,
      applicationStatus: profile.application_status || null,
      establishedEaser,
      currentAgreementVersion: CONTRACTOR_AGREEMENT_VERSION,
      priorAgreementOnFile: !!profile.contractor_agreement_signed_at,
      requiresAgreement,
      agreementPendingOnly: profile.identity_verified === true && requiresAgreement,
      resumeUrl,
    });
  }

  const requiresAgreement = !profile.contractor_agreement_signed_at
    || !profile.code_of_conduct_agreed_at
    || profile.contractor_agreement_version !== CONTRACTOR_AGREEMENT_VERSION;
  if (profile.identity_verified === true && !requiresAgreement) {
    try {
      await clearIdentityResumeToken(sb, profile.id);
    } catch (err) {
      console.error('verification-link token revocation error:', err?.message || err);
      return res.status(503).json({ error: 'Verification completion could not be saved. Please try again.' });
    }
    return res.status(200).json({
      ok: true,
      alreadyVerified: true,
      establishedEaser: isEstablishedEaser(profile),
    });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const signedName = String(body.fullName || profile.full_name || '').trim();
  const submittedResumeToken = resumeToken;

  if (requiresAgreement) {
    if (signedName.split(/\s+/).filter(Boolean).length < 2) {
      return res.status(400).json({ error: 'Enter your full legal name before continuing.' });
    }
    const normalizeSignedName = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (normalizeSignedName(signedName) !== normalizeSignedName(profile.full_name)) {
      return res.status(400).json({
        error: 'The signed name must match the full legal name on the application. Contact support if it needs correction.',
      });
    }
    if (body.contractorAgreementSigned !== true) {
      return res.status(400).json({ error: 'You must accept the contractor agreement before continuing.' });
    }
    if (body.codeOfConductAccepted !== true) {
      return res.status(400).json({ error: 'You must accept the code of conduct before continuing.' });
    }
  }

  if (requiresAgreement) {
    try {
      const agreement = await recordAgreementAcceptance(sb, {
        profileId: profile.id,
        signedName,
        agreementIp: getClientIp(req),
        agreementUserAgent: req.headers['user-agent'],
        rotateResumeToken: true,
        expectedResumeToken: authMode === 'token' ? resumeToken : null,
      });
      resumeToken = agreement.resumeToken;
      resumeUrl = buildIdentityResumeUrl(resumeToken);
    } catch (err) {
      console.error('verification-link agreement persistence error:', err?.message || err);
      const replayed = /already used or expired/i.test(String(err?.message || ''));
      return res.status(replayed ? 409 : 503).json({
        error: replayed
          ? 'This verification link was already used or expired. Use the newest link sent to you.'
          : 'Agreement acceptance could not be saved. Nothing else was started; please try again.',
      });
    }

    if (profile.identity_verified === true) {
      try {
        await clearIdentityResumeToken(sb, profile.id);
      } catch (err) {
        console.error('verification-link token revocation error:', err?.message || err);
        if (authMode === 'token') {
          try {
            await restoreIdentityResumeTokenAfterFailedStart(sb, profile.id, {
              expectedToken: resumeToken,
              priorToken: submittedResumeToken,
            });
          } catch (restoreError) {
            console.error('verification-link token restoration error:', restoreError?.message || restoreError);
          }
        }
        return res.status(503).json({ error: 'Agreement was saved, but verification completion needs to be retried.' });
      }
      return res.status(200).json({
        ok: true,
        alreadyVerified: true,
        agreementRecorded: true,
        establishedEaser: isEstablishedEaser(profile),
      });
    }
  } else {
    // No legal write is needed, but the current bearer is still exchanged with
    // an expected-token CAS before a Stripe session can be created.
    try {
      resumeToken = await rotateIdentityResumeToken(
        sb,
        profile.id,
        authMode === 'token' ? { expectedToken: resumeToken } : {},
      );
      resumeUrl = buildIdentityResumeUrl(resumeToken);
    } catch (err) {
      console.error('verification-link token exchange error:', err?.message || err);
      const replayed = /already used or expired/i.test(String(err?.message || ''));
      return res.status(replayed ? 409 : 503).json({
        error: replayed
          ? 'This verification link was already used or expired. Use the newest link sent to you.'
          : 'A secure verification link could not be refreshed. Please try again.',
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
    if (authMode === 'token') {
      try {
        await restoreIdentityResumeTokenAfterFailedStart(sb, profile.id, {
          expectedToken: resumeToken,
          priorToken: submittedResumeToken,
        });
        resumeToken = submittedResumeToken;
        resumeUrl = buildIdentityResumeUrl(resumeToken);
      } catch (restoreError) {
        console.error('verification-link token restoration error:', restoreError?.message || restoreError);
        return res.status(503).json({
          error: 'Identity verification could not start and the secure link needs support review. Contact support before retrying.',
        });
      }
    }
    return res.status(503).json({
      error: 'Identity verification is temporarily unavailable. Please try again shortly.',
      resumeUrl,
    });
  }
}
