import crypto from 'crypto';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

// Required for raw body access — Vercel must not parse the body
export const config = { api: { bodyParser: false } };

// Map Persona template env vars → check keys
function getCheckName(templateId) {
  if (templateId === process.env.PERSONA_TEMPLATE_GOV_ID)  return 'gov';
  if (templateId === process.env.PERSONA_TEMPLATE_SELFIE)  return 'selfie';
  if (templateId === process.env.PERSONA_TEMPLATE_DATABASE) return 'db';
  return null;
}

/**
 * Read the raw request body as a string (needed for HMAC verification).
 */
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * POST /api/assembler/persona-webhook
 * Receives webhook from Persona when a background check inquiry completes.
 * Tracks 3 separate checks (gov, selfie, db). All 3 must pass for full verification.
 *
 * Persona signature header format:  t=TIMESTAMP,v1=HEXSIG
 * HMAC is computed over:            timestamp + '.' + rawBody
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── 1. Read raw body before any parsing ──
  const rawBody = await getRawBody(req);

  // ── 2. Verify Persona webhook signature ──
  const webhookSecret = process.env.PERSONA_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  const sigHeader = req.headers['persona-signature'] || '';
  // Header format: t=TIMESTAMP,v1=HEXSIG
  const tPart  = sigHeader.split(',').find(p => p.startsWith('t='));
  const v1Part = sigHeader.split(',').find(p => p.startsWith('v1='));

  if (!tPart || !v1Part) {
    console.error('Persona webhook: malformed signature header', sigHeader);
    return res.status(401).json({ error: 'Invalid signature header' });
  }

  const timestamp = tPart.split('=')[1];
  const v1sig     = v1Part.split('=')[1];

  // Persona signs over: timestamp + '.' + rawBody
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(timestamp + '.' + rawBody)
    .digest('hex');

  if (v1sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(v1sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
    console.error('Persona webhook: signature mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── 3. Parse body now that signature is verified ──
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const payload = event?.data?.attributes?.payload?.data;
  const attrs = payload?.attributes || {};
  const inquiryId = payload?.id;
  const status = attrs.status;
  // Persona may send camelCase or kebab-case depending on config
  const referenceId = attrs.referenceId || attrs['reference-id'];
  const templateId = attrs.inquiryTemplateId || attrs['inquiry-template-id'];

  if (!inquiryId) {
    return res.status(200).json({ ok: true, skipped: 'no inquiry id' });
  }

  if (!referenceId) {
    console.error('Persona webhook: no referenceId in payload', { inquiryId });
    return res.status(200).json({ ok: true, skipped: 'no reference id' });
  }

  const checkName = getCheckName(templateId);
  if (!checkName) {
    console.error('Persona webhook: unknown template', { templateId, inquiryId });
    return res.status(200).json({ ok: true, skipped: 'unknown template' });
  }

  const sb = getSupabase();

  // Look up profile by referenceId (= user id)
  const { data: profile, error: profileErr } = await sb.from('profiles')
    .select('id, full_name, email, tier, persona_checks')
    .eq('id', referenceId)
    .maybeSingle();

  if (profileErr || !profile) {
    console.error('Persona webhook: profile not found', { inquiryId, referenceId, profileErr });
    return res.status(200).json({ ok: true, skipped: 'profile not found' });
  }

  const passed = status === 'completed' || status === 'approved';
  const failed = status === 'failed' || status === 'declined' || status === 'needs_review';

  if (!passed && !failed) {
    return res.status(200).json({ ok: true, status: 'noted' });
  }

  const firstName = (profile.full_name || 'Assembler').split(' ')[0];

  // ── Handle failure ──
  if (failed) {
    // Mark this check as failed and notify
    const checks = { ...(profile.persona_checks || {}), [checkName]: 'failed' };
    await sb.from('profiles').update({ persona_checks: checks }).eq('id', profile.id);

    try {
      await sendEmail({
        to: ownerEmail(),
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `Background Check Failed — ${esc(profile.full_name)} (${checkName})`,
        html: `<p><strong>${esc(profile.full_name)}</strong> (${esc(profile.email)}) failed the <strong>${checkName}</strong> check.</p><p>Status: ${esc(status)} &bull; Inquiry: ${esc(inquiryId)}</p><p>Action may be required.</p>`,
        replyTo: profile.email,
      });
    } catch (e) { console.error('Owner notify error:', e); }

    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'AssembleAtEase — Verification Update',
        html: buildRejectionEmail(firstName, checkName),
        replyTo: ownerEmail(),
      });
    } catch (e) { console.error('Rejection email error:', e); }

    return res.status(200).json({ ok: true, check: checkName, passed: false });
  }

  // ── Handle pass — update this check ──
  const checks = { ...(profile.persona_checks || {}), [checkName]: true };
  const allPassed = checks.gov === true && checks.selfie === true && checks.db === true;

  const updates = { persona_checks: checks };
  if (allPassed) {
    updates.persona_verified = true;
    updates.persona_verified_at = new Date().toISOString();
    if (profile.tier === 'pending') updates.tier = 'starter';
  }

  const { error: updateErr } = await sb.from('profiles')
    .update(updates)
    .eq('id', profile.id);

  if (updateErr) {
    console.error('Persona webhook: update error', updateErr);
    return res.status(500).json({ error: 'Failed to update profile' });
  }

  // Notify owner of individual check completion
  try {
    const subj = allPassed
      ? `Assembler Fully Verified — ${esc(profile.full_name)}`
      : `Check Passed — ${esc(profile.full_name)} (${checkName})`;
    const body = allPassed
      ? `<p><strong>${esc(profile.full_name)}</strong> passed ALL 3 verification checks. Tier: <strong>${updates.tier || profile.tier}</strong>.</p>`
      : `<p><strong>${esc(profile.full_name)}</strong> passed the <strong>${checkName}</strong> check. Remaining: ${['gov','selfie','db'].filter(k => checks[k] !== true).join(', ') || 'none'}.</p>`;
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: subj,
      html: body,
      replyTo: profile.email,
    });
  } catch (e) { console.error('Owner notify error:', e); }

  // Only email assembler when ALL checks pass
  if (allPassed) {
    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Welcome to AssembleAtEase — You\'re Verified!',
        html: buildApprovalEmail(firstName),
        replyTo: ownerEmail(),
      });
    } catch (e) { console.error('Approval email error:', e); }
  }

  return res.status(200).json({ ok: true, check: checkName, passed: true, allPassed, tier: updates.tier || profile.tier });
}

function buildApprovalEmail(firstName) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:12px 0 4px;font-size:22px;font-weight:700;color:#1a1a1a">You're Verified, ${esc(firstName)}!</p>
    <p style="margin:0 0 24px;font-size:14px;color:#52525b;line-height:1.6">Your identity has been verified and your account is now active. You can start browsing and accepting jobs.</p>
    <a href="https://www.assembleatease.com/auth/login" style="display:inline-block;background:#0097a7;color:#fff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:6px;text-decoration:none">Log In &amp; Start Working</a>
    <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa">AssembleAtEase &bull; Austin, TX</p>
  </td></tr></table>
</div></body></html>`;
}

function buildRejectionEmail(firstName, checkName) {
  const checkLabel = { gov: 'Government ID', selfie: 'Selfie', db: 'Database' }[checkName] || checkName;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e4e4e7"><tr><td style="padding:32px 24px">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:12px 0 4px;font-size:22px;font-weight:700;color:#1a1a1a">Verification Update</p>
    <p style="margin:0 0 16px;font-size:14px;color:#52525b;line-height:1.6">Hi ${esc(firstName)}, we were unable to verify your <strong>${esc(checkLabel)}</strong> check. If you believe this is an error, please contact us at service@assembleatease.com.</p>
    <p style="margin:0;font-size:12px;color:#a1a1aa;text-align:center">AssembleAtEase &bull; Austin, TX</p>
  </td></tr></table>
</div></body></html>`;
}
