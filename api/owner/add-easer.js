import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { buildIdentityResumeUrl, ensureIdentityResumeToken } from '../_assembler-onboarding.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/owner/add-easer
 * Owner manually adds an Easer — skips the $30 application fee.
 * Creates auth account, profile, and sends them a password-set link plus
 * a reusable onboarding link for agreement acceptance + identity verification.
 * The Easer still appears as 'pending' in the Easers tab and must be
 * approved by the owner after identity verification — same as normal flow.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { fullName, email, phone, city, zip, services, hasTools, hasTransport, yearsExperience, bio } = req.body;

  if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required' });
  if (fullName.trim().split(/\s+/).filter(Boolean).length < 2) return res.status(400).json({ error: 'Please enter the Easer\'s first and last name.' });
  if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (!city?.trim()) return res.status(400).json({ error: 'City is required' });

  const sb = getSupabase();
  const cleanName  = fullName.trim();
  const cleanEmail = email.trim().toLowerCase();
  const tempPassword = randomUUID() + randomUUID();

  // ── Create auth user ──────────────────────────────────────────────
  const { data: authData, error: authError } = await sb.auth.admin.createUser({
    email: cleanEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: { role: 'assembler', full_name: cleanName },
  });

  if (authError) {
    if (authError.message?.includes('already')) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error('Auth create error:', authError);
    return res.status(500).json({ error: 'Failed to create account' });
  }

  const userId = authData.user.id;

  // ── Create profile ────────────────────────────────────────────────
  await sb.from('profiles').upsert({
    id: userId,
    full_name: cleanName,
    email: cleanEmail,
    phone: phone?.trim() || null,
    role: 'assembler',
    city: city.trim(),
    zip: zip?.trim() || null,
    services_offered: Array.isArray(services) ? services : [],
    has_tools: hasTools ?? true,
    has_transport: hasTransport ?? true,
    years_experience: parseInt(yearsExperience, 10) || 0,
    bio: bio?.trim() || null,
    tier: 'pending',
    identity_verified: false,
    application_status: 'applied',
    payment_confirmed: true,
    application_fee_paid: false,  // fee waived by owner
    fee_waived_by_owner: true,
  }, { onConflict: 'id' });

  const verificationResumeToken = await ensureIdentityResumeToken(sb, { id: userId });
  const verificationResumeUrl = buildIdentityResumeUrl(verificationResumeToken);

  // ── Password reset link so they can set their own password ────────
  let passwordSetUrl = SITE + '/auth/set-password';
  try {
    const { data: linkData } = await sb.auth.admin.generateLink({
      type: 'recovery',
      email: cleanEmail,
      options: { redirectTo: SITE + '/auth/set-password' },
    });
    if (linkData?.properties?.action_link) {
      passwordSetUrl = linkData.properties.action_link;
    }
  } catch (e) {
    console.error('Password link generation error (non-fatal):', e);
  }

  // ── Email to Easer ────────────────────────────────────────────────
  const firstName = cleanName.split(' ')[0];
  try {
    await sendEmail({
      to: cleanEmail,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Welcome to AssembleAtEase — Complete Your Setup',
      replyTo: ownerEmail(),
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Welcome aboard, ${esc(firstName)}!</p>
    <p style="margin:0 0 20px;font-size:14px;color:#52525b;line-height:1.7">You've been added to the AssembleAtEase Easer team. Complete the steps below so we can finish your onboarding review.</p>

    <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Step 1 — Set your password</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="background:#00BFFF;border-radius:8px"><a href="${esc(passwordSetUrl)}" style="display:inline-block;padding:12px 28px;color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px">Set My Password →</a></td></tr></table>

    <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">Step 2 — Review your agreement and verify your identity</p>
    <p style="margin:0 0 12px;font-size:13px;color:#52525b;line-height:1.6">Use the secure AssembleAtEase link below to confirm your onboarding agreement and complete Stripe identity verification. If you switch devices or the Stripe page expires, this same link will reopen it for you.</p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="background:#1a1a1a;border-radius:8px"><a href="${esc(verificationResumeUrl)}" style="display:inline-block;padding:12px 28px;color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px">Continue Onboarding →</a></td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:16px 18px">
      <p style="margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;color:#71717a">What happens next</p>
      <ol style="margin:8px 0 0;padding-left:16px;font-size:13px;color:#52525b;line-height:1.8">
        <li>Set your password and complete your identity verification.</li>
        <li>Our team reviews your profile after verification is submitted.</li>
        <li>Once approved, you can go online and start receiving job assignments in Austin, TX.</li>
      </ol>
    </td></tr></table>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:16px 24px;text-align:center;font-size:11px;color:#a1a1aa">AssembleAtEase &bull; Austin, TX</td></tr></table>
</div></body></html>`,
    });
  } catch (e) { console.error('Easer welcome email error:', e); }

  // ── Owner notification ────────────────────────────────────────────
  try {
    await sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Easer Manually Added — ' + cleanName,
      html: `<p style="font-family:sans-serif;font-size:14px;color:#111"><strong>${esc(cleanName)}</strong> (${esc(cleanEmail)}) was manually added as an Easer. Application fee waived. They have been sent a password setup link and a reusable onboarding link for agreement acceptance plus identity verification. They appear as <strong>Pending</strong> in the Easers tab — approve after they complete onboarding.</p>`,
      replyTo: cleanEmail,
    });
  } catch (e) { console.error('Owner notification error:', e); }

  console.log(JSON.stringify({ audit: true, action: 'owner_add_easer', actor: 'owner', userId, email: cleanEmail, feeWaived: true, timestamp: new Date().toISOString() }));
  return res.status(200).json({ success: true, userId });
}
