import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { buildIdentityResumeUrl, ensureIdentityResumeToken } from '../_assembler-onboarding.js';

export const config = { api: { bodyParser: false } };

async function updateOptionalIdentityFields(sb, profileId, updates) {
  try {
    await sb.from('profiles').update(updates).eq('id', profileId);
  } catch (e) {
    console.warn('Stripe Identity optional field update skipped:', e?.message || e);
  }
}

async function findAssemblerProfileForSession(sb, session) {
  const metadataUserId = String(session?.metadata?.userId || '').trim();
  if (metadataUserId) {
    const { data: byId } = await sb
      .from('profiles')
      .select('id, full_name, email, status, tier, application_status, identity_resume_token')
      .eq('id', metadataUserId)
      .eq('role', 'assembler')
      .maybeSingle();
    if (byId) return byId;
  }

  const { data: bySessionId } = await sb
    .from('profiles')
    .select('id, full_name, email, status, tier, application_status, identity_resume_token')
    .eq('stripe_verification_id', session.id)
    .eq('role', 'assembler')
    .maybeSingle();

  return bySessionId || null;
}

/**
 * POST /api/webhook/stripe-identity
 * Handles Stripe Identity verification session webhooks.
 * Auto-updates id_verified, id_verification_status on profiles.
 *
 * Events handled:
 *   identity.verification_session.verified   → id_verified=true
 *   identity.verification_session.requires_input → id_verification_status=failed
 *   identity.verification_session.processing → id_verification_status=pending (no change)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_IDENTITY_WEBHOOK_SECRET;

  if (!sig || !webhookSecret || !process.env.STRIPE_SECRET_KEY) {
    console.warn('Stripe Identity webhook missing signature, webhook secret, or Stripe secret key');
    return res.status(500).json({ error: 'Stripe Identity webhook is not configured' });
  }

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch(err) {
    console.error('Stripe Identity webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  const sb = getSupabase();
  const session = event.data.object;

  const profile = await findAssemblerProfileForSession(sb, session);

  if (!profile) {
    // Session not linked to an Easer — log and return 200 (Stripe expects 200 ACK)
    console.warn('Stripe Identity webhook: no Easer found for session', session.id);
    return res.status(200).json({ received: true, note: 'No matching Easer found' });
  }

  if (event.type === 'identity.verification_session.verified') {
    // Identity verification passed
    await sb.from('profiles').update({
      identity_verified: true,
      identity_verified_at: new Date().toISOString(),
    }).eq('id', profile.id);
    await updateOptionalIdentityFields(sb, profile.id, {
      id_verification_status: 'verified',
      stripe_identity_session_id: session.id,
    });

    // Notify owner to approve the applicant
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verified — ${esc(profile.full_name)} is ready to approve`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#00BFFF">Easer ID Verified</h2>
        <p><strong>${esc(profile.full_name)}</strong> (${esc(profile.email)}) has successfully completed Stripe Identity verification.</p>
        <p>Their account status is <strong>${esc(profile.status || 'pending')}</strong>. You can now approve their application.</p>
        <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">Open Owner Dashboard to Approve</a></p>
      </div>`,
      meta: { notificationType: 'identity_verified_owner', recipientType: 'owner' },
    }).catch(e => console.error('ID verified owner email error:', e));

    sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Identity Verified — Application Review Pending',
      html: buildApplicantVerifiedEmail((profile.full_name || 'there').split(' ')[0]),
      replyTo: ownerEmail(),
      meta: { notificationType: 'identity_verified_applicant', recipientType: 'easer', recipientUserId: profile.id },
    }).catch(e => console.error('ID verified applicant email error:', e));

    console.log('Stripe Identity: verified for', profile.full_name, profile.id);

  } else if (event.type === 'identity.verification_session.requires_input') {
    // Verification failed or needs more info
    const failureCode = session.last_error?.code || 'unknown';
    const failureReason = session.last_error?.reason || 'Verification could not be completed';

    await sb.from('profiles').update({
      identity_verified: false,
    }).eq('id', profile.id);
    await updateOptionalIdentityFields(sb, profile.id, {
      id_verification_status: 'failed',
      stripe_identity_session_id: session.id,
    });

    const resumeToken = await ensureIdentityResumeToken(sb, profile);
    const resumeUrl = buildIdentityResumeUrl(resumeToken);

    // Notify owner
    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verification Failed — ${esc(profile.full_name)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#dc2626">ID Verification Failed</h2>
        <p><strong>${esc(profile.full_name)}</strong> (${esc(profile.email)}) failed Stripe Identity verification.</p>
        <p><strong>Code:</strong> ${esc(failureCode)}<br><strong>Reason:</strong> ${esc(failureReason)}</p>
        <p>Review their application in the <a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">owner dashboard</a> and decide whether to reject or request re-verification.</p>
      </div>`,
      meta: { notificationType: 'identity_failed_owner', recipientType: 'owner' },
    }).catch(e => console.error('ID failed owner email error:', e));

    sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Action Required — Retry Identity Verification',
      html: buildApplicantRetryEmail((profile.full_name || 'there').split(' ')[0], failureReason, resumeUrl),
      replyTo: ownerEmail(),
      meta: { notificationType: 'identity_failed_applicant', recipientType: 'easer', recipientUserId: profile.id },
    }).catch(e => console.error('ID failed applicant email error:', e));

    console.log('Stripe Identity: failed for', profile.full_name, failureCode);

  } else if (event.type === 'identity.verification_session.processing') {
    // Still processing — update session ID if not set
    await updateOptionalIdentityFields(sb, profile.id, {
      stripe_identity_session_id: session.id,
      id_verification_status: 'pending',
    });

    console.log('Stripe Identity: processing for', profile.full_name);
  }

  return res.status(200).json({ received: true, event: event.type, profileId: profile.id });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildApplicantVerifiedEmail(firstName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#166534">Identity verified, ${esc(firstName)}.</p>
    <p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.7">Stripe identity verification has been submitted successfully. AssembleAtEase will now review your application and email you with the next decision.</p>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">No further action is needed from you right now.</p>
  </td></tr></table>
</div></body></html>`;
}

function buildApplicantRetryEmail(firstName, reason, resumeUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:28px 24px">
    <p style="margin:0 0 10px;font-size:22px;font-weight:700;color:#991b1b">Action required, ${esc(firstName)}.</p>
    <p style="margin:0 0 14px;font-size:14px;color:#52525b;line-height:1.7">Your identity verification could not be completed. Stripe returned this message: <strong>${esc(reason)}</strong>.</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.7">Use the secure AssembleAtEase link below to retry. If the Stripe page expires or you switch devices, use this same link again.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:#00BFFF;border-radius:8px">
      <a href="${esc(resumeUrl)}" style="display:inline-block;padding:13px 28px;color:#001f2b;font-size:14px;font-weight:800;text-decoration:none;border-radius:8px">Retry Identity Verification</a>
    </td></tr></table>
    <p style="margin:0;font-size:13px;color:#71717a;line-height:1.6">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
</div></body></html>`;
}
