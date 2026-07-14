import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimitKey } from '../_ratelimit.js';
import { logActivity } from '../booking/_activity.js';
import {
  buildIdentityResumeUrl,
  CONTRACTOR_AGREEMENT_VERSION,
  ensureIdentityResumeToken,
} from '../_assembler-onboarding.js';
import { isApplicationFeeSatisfied } from '../_easer-application-fee.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const assemblerId = String(req.body?.assemblerId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(assemblerId)) {
    return res.status(400).json({ error: 'Valid Easer ID is required.' });
  }
  if (!await rateLimitKey(`owner-easer-onboarding:${assemblerId}`, 'default')) {
    return res.status(429).json({ error: 'A link was sent recently. Wait a minute before trying again.' });
  }

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role, status, application_status, full_name, email, identity_verified, contractor_agreement_signed_at, contractor_agreement_version, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, identity_resume_token, identity_resume_token_created_at, identity_resume_token_expires_at')
    .eq('id', assemblerId)
    .maybeSingle();

  if (profileError) {
    console.error('Owner onboarding resend profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({ error: 'Easer onboarding status could not be verified.' });
  }
  if (!profile || profile.role !== 'assembler') return res.status(404).json({ error: 'Easer not found.' });

  const status = String(profile.status || '').toLowerCase();
  const applicationStatus = String(profile.application_status || '').toLowerCase();
  if (status !== 'pending' || !['applied', 'pending', 'reviewing'].includes(applicationStatus)) {
    return res.status(409).json({ error: 'Onboarding links can be reissued only for a pending Easer application.' });
  }
  if (['requested', 'reviewing', 'completed'].includes(String(profile.account_closure_status || '').toLowerCase())) {
    return res.status(409).json({ error: 'This Easer has an account-closure request. Resolve it before onboarding.' });
  }
  if (!isApplicationFeeSatisfied(profile)) {
    return res.status(409).json({ error: 'Application fee truth requires owner reconciliation before onboarding can continue.' });
  }
  const agreementCurrent = Boolean(
    profile.contractor_agreement_signed_at
    && profile.contractor_agreement_version === CONTRACTOR_AGREEMENT_VERSION
  );
  if (profile.identity_verified && agreementCurrent) {
    return res.status(409).json({ error: 'Identity and the current agreement are already complete. Review or approve the application instead.' });
  }
  if (!profile.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    return res.status(409).json({ error: 'The pending Easer has no valid delivery email.' });
  }

  const priorTokenState = {
    token: profile.identity_resume_token || null,
    createdAt: profile.identity_resume_token_created_at || null,
    expiresAt: profile.identity_resume_token_expires_at || null,
  };

  let resumeToken;
  try {
    resumeToken = await ensureIdentityResumeToken(sb, profile, { rotate: true });
  } catch (error) {
    console.error('Owner onboarding token rotation failed:', error.message || error);
    return res.status(503).json({ error: 'A secure onboarding link could not be created.' });
  }

  const onboardingUrl = buildIdentityResumeUrl(resumeToken);
  const firstName = String(profile.full_name || 'there').trim().split(/\s+/)[0];
  let delivery;
  try {
    delivery = await sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your New Secure AssembleAtEase Onboarding Link',
      replyTo: ownerEmail(),
      meta: {
        notificationType: 'easer_onboarding_link_reissued',
        recipientType: 'easer',
        recipientUserId: profile.id,
        disableDedupe: true,
      },
      html: buildEmail({ firstName, onboardingUrl }),
    });
  } catch (error) {
    delivery = { ok: false, error: error?.message || String(error) };
  }

  const delivered = delivery?.ok === true && !delivery?.suppressed;
  if (!delivered) {
    const { error: rollbackError } = await sb.from('profiles').update({
      identity_resume_token: priorTokenState.token,
      identity_resume_token_created_at: priorTokenState.createdAt,
      identity_resume_token_expires_at: priorTokenState.expiresAt,
    }).eq('id', profile.id).eq('identity_resume_token', resumeToken);
    if (rollbackError) {
      console.error('Owner onboarding token rollback failed:', rollbackError.message || rollbackError);
    }
    await logActivity(sb, {
      bookingId: null,
      eventType: 'easer_onboarding_link_delivery_failed',
      actorType: 'owner',
      actorName: 'Owner',
      description: `Secure onboarding link delivery failed for ${profile.full_name || profile.email}`,
      metadata: { assemblerId: profile.id, email: profile.email, tokenRollbackFailed: Boolean(rollbackError) },
    });
    return res.status(502).json({
      error: rollbackError
        ? 'Email delivery and secure-link rollback both need owner review. Do not resend until the applicant record is checked.'
        : 'The onboarding email was not delivered. The prior link state was preserved.',
    });
  }

  await logActivity(sb, {
    bookingId: null,
    eventType: 'easer_onboarding_link_reissued',
    actorType: 'owner',
    actorName: 'Owner',
    description: `Secure onboarding link reissued to ${profile.full_name || profile.email}`,
    metadata: { assemblerId: profile.id, email: profile.email },
  });
  return res.status(200).json({
    success: true,
    emailDelivered: true,
    message: 'A new time-limited onboarding link was sent to the Easer email on file.',
  });
}

function buildEmail({ firstName, onboardingUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b">
<div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden">
<div style="padding:22px 24px;border-bottom:3px solid #00BFFF"><table cellpadding="0" cellspacing="0"><tr><td><img src="${LOGO}" width="38" height="38" alt="AssembleAtEase" style="display:block;border-radius:50%"></td><td style="padding-left:12px;font-weight:700">AssembleAtEase</td></tr></table></div>
<div style="padding:28px 24px"><h1 style="font-size:22px;margin:0 0 12px">Continue your Easer onboarding</h1><p style="font-size:14px;line-height:1.7;color:#52525b">Hi ${esc(firstName)}, the owner issued a new time-limited link for your pending Easer application. The previous onboarding link is no longer valid.</p>
<p style="font-size:14px;line-height:1.7;color:#52525b">Use this link to complete any missing contractor-agreement or Stripe Identity steps. Approval is still required before you can receive jobs.</p>
<table cellpadding="0" cellspacing="0" style="margin:20px 0"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${esc(onboardingUrl)}" style="display:inline-block;padding:13px 24px;color:#002b3a;text-decoration:none;font-weight:700">Continue Secure Onboarding</a></td></tr></table>
<p style="font-size:12px;line-height:1.6;color:#71717a">If you did not request this link or need help, contact service@assembleatease.com. Do not forward this email.</p></div></div></div></body></html>`;
}
