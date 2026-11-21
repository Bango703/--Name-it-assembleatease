/**
 * What happens when an identity provider says an Easer applicant passed, or
 * must try again. ONE place for both providers (Stripe Identity through
 * api/assembler/stripe-webhook.js, Persona through api/webhook/persona.js), so
 * the profile fields and the emails can never differ by provider (Article 3).
 * Only a provider's signed webhook calls these; nothing in the browser can.
 */
import { sendEmail, ownerEmail, esc } from './_email.js';
import { buildIdentityResumeUrl, ensureIdentityResumeToken, updateProfileRequired } from './_assembler-onboarding.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * Mark the Easer verified and tell the owner and the applicant.
 * referenceUpdates holds the provider's own reference (session or inquiry id).
 * notificationKey (optional) makes each email exactly-once across retries.
 */
export async function recordIdentityVerified(sb, { userId, profile, referenceUpdates = {}, context = 'Identity verified state', notificationKey = null }) {
  await updateProfileRequired(sb, userId, {
    identity_verified: true,
    identity_verified_at: new Date().toISOString(),
    id_verification_status: 'verified',
    ...referenceUpdates,
    identity_resume_token: null,
    identity_resume_token_created_at: null,
    identity_resume_token_expires_at: null,
  }, context);

  if (!profile) return;
  try {
    await sendEmail({
      to: ownerEmail(),
      subject: `Identity Verified — ${esc(profile.full_name)}`,
      html: buildVerifiedEmail(profile.full_name, profile.email, 'verified'),
      meta: { notificationType: 'identity_verified_owner', recipientType: 'owner', ...(notificationKey ? { notificationKey: `${notificationKey}:owner` } : {}) },
    });
  } catch (e) { console.error('Owner verified email error:', e); }

  try {
    await sendEmail({
      to: profile.email,
      subject: 'Identity verified — next steps',
      html: buildApplicantVerifiedEmail(String(profile.full_name || '').split(' ')[0]),
      replyTo: ownerEmail(),
      meta: { notificationType: 'identity_verified_applicant', recipientType: 'easer', recipientUserId: userId, ...(notificationKey ? { notificationKey: `${notificationKey}:applicant` } : {}) },
    });
  } catch (e) { console.error('Applicant verified email error:', e); }
}

/**
 * The check did not pass: keep the Easer unverified, issue a fresh resume link,
 * and tell the owner and the applicant with the provider's reason.
 */
export async function recordIdentityRetry(sb, { userId, profile, referenceUpdates = {}, reason = 'verification could not be completed', context = 'Identity retry state', notificationKey = null }) {
  await updateProfileRequired(sb, userId, {
    identity_verified: false,
    id_verification_status: 'failed',
    ...referenceUpdates,
  }, context);
  const resumeToken = await ensureIdentityResumeToken(sb, { id: userId }, { rotate: true });
  const resumeUrl = buildIdentityResumeUrl(resumeToken);

  if (!profile) return;
  try {
    await sendEmail({
      to: ownerEmail(),
      subject: `Identity Verification Failed — ${esc(profile.full_name)}`,
      html: buildVerifiedEmail(profile.full_name, profile.email, 'failed', reason),
      meta: { notificationType: 'identity_failed_owner', recipientType: 'owner', ...(notificationKey ? { notificationKey: `${notificationKey}:owner` } : {}) },
    });
  } catch (e) { console.error('Owner failed email error:', e); }

  try {
    await sendEmail({
      to: profile.email,
      subject: 'Action Required — Retry Identity Verification',
      html: buildAssemblerFailEmail(String(profile.full_name || '').split(' ')[0], reason, resumeUrl),
      replyTo: ownerEmail(),
      meta: { notificationType: 'identity_failed_applicant', recipientType: 'easer', recipientUserId: userId, ...(notificationKey ? { notificationKey: `${notificationKey}:applicant` } : {}) },
    });
  } catch (e) { console.error('Assembler failed email error:', e); }
}

function buildVerifiedEmail(fullName, email, status, reason = '') {
  const isVerified = status === 'verified';
  const bgColor = isVerified ? '#f0fdf4' : '#fef2f2';
  const borderColor = isVerified ? '#bbf7d0' : '#fecaca';
  const textColor = isVerified ? '#166534' : '#991b1b';
  const headline = isVerified
    ? `${esc(fullName)} - Identity Verified`
    : `${esc(fullName)} — Identity Verification Failed`;
  const detail = isVerified
    ? 'The assembler has successfully completed identity verification and is ready for approval.'
    : `Verification could not be completed. Reason: ${esc(reason)}`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:24px">
    <table cellpadding="0" cellspacing="0"><tr>
      <td><img src="${LOGO}" alt="AssembleAtEase" width="32" height="32" style="border-radius:50%"/></td>
      <td style="padding-left:10px;font-size:15px;font-weight:700;color:#1a1a1a">AssembleAtEase</td>
    </tr></table>
    <p style="margin:16px 0 4px;font-size:17px;font-weight:700;color:#1a1a1a">${headline}</p>
    <p style="margin:0 0 16px;font-size:13px;color:#52525b">${esc(email)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:${bgColor};border:1px solid ${borderColor};border-radius:6px"><tr>
      <td style="padding:12px 16px;font-size:13px;color:${textColor}">${detail}</td>
    </tr></table>
  </td></tr></table>
</div></body></html>`;
}

function buildApplicantVerifiedEmail(firstName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#166534">Identity verified, ${esc(firstName)}.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Your identity verification is complete. We will email you when your application status changes.</p>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">No further action is needed from you right now.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildAssemblerFailEmail(firstName, reason, resumeUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1a1a1a">Action required, ${esc(firstName)}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Your identity verification could not be completed. Reason: <strong>${esc(reason)}</strong></p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Use the time-limited AssembleAtEase link below to retry. If another attempt is required, use the newest link sent to you.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${esc(resumeUrl)}" style="display:inline-block;padding:12px 28px;color:#001f2b;font-size:14px;font-weight:800;text-decoration:none;border-radius:8px">Retry Identity Verification</a></td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF">service@assembleatease.com</a>.</p>
  </td></tr></table>
</div></body></html>`;
}
