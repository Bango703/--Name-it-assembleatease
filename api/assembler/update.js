import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';

/**
 * POST /api/assembler/update
 * Owner-only: update assembler tier or suspend/reactivate.
 * Body: { assemblerId, tier?, suspended? }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId, tier, suspended } = req.body;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });

  const validTiers = ['pending', 'starter', 'verified', 'elite', 'suspended'];
  if (tier && !validTiers.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier' });
  }

  const sb = getSupabase();

  // Verify assembler exists
  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id, full_name, email, tier, identity_verified')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (lookupErr || !profile) {
    return res.status(404).json({ error: 'Assembler not found' });
  }

  // Block approval of unverified assemblers
  if (tier && tier !== 'pending' && profile.tier === 'pending' && !profile.identity_verified) {
    return res.status(400).json({
      error: 'Assembler must complete identity verification before approval',
    });
  }

  const updates = {};
  if (tier) updates.tier = tier;
  if (typeof suspended === 'boolean') updates.suspended = suspended;

  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No updates provided' });
  }

  const { error: updateErr } = await sb
    .from('profiles')
    .update(updates)
    .eq('id', assemblerId);

  if (updateErr) {
    console.error('Assembler update error:', updateErr);
    return res.status(500).json({ error: 'Failed to update assembler' });
  }

  // ── If approving (pending → starter), send welcome email and update waitlist ──
  if (tier && tier !== 'pending' && profile.tier === 'pending') {
    // Update waitlist status to approved
    try {
      await sb.from('assembler_waitlist')
        .update({ status: 'approved' })
        .eq('email', profile.email.toLowerCase());
    } catch (e) { console.error('Waitlist approve update error:', e); }

    // Send welcome email
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Welcome to AssembleAtEase — Your account is approved',
        replyTo: 'service@assembleatease.com',
        html: buildWelcomeEmail(firstName, profile.email, tier),
      });
    } catch (e) { console.error('Welcome email error:', e); }
  }

  return res.status(200).json({ success: true, assemblerId, updates });
}

function buildWelcomeEmail(firstName, email, tier) {
  var tierLabel = { starter: 'Starter', verified: 'Verified', elite: 'Elite' }[tier] || tier;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Hi ${esc(firstName)}, congratulations!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your application has been approved. You are now an official <strong>AssembleAtEase</strong> assembler.</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;margin-bottom:24px"><tr><td style="padding:14px 18px;text-align:center">
      <p style="margin:0;font-size:13px;color:#166534;font-weight:700">Your current tier: ${esc(tierLabel)}</p>
    </td></tr></table>

    <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">Log in to your assembler dashboard to get started:</p>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0">
      <a href="https://www.assembleatease.com/auth/login" style="display:inline-block;background:#0097a7;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700">Log In to Your Dashboard &rarr;</a>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:24px 0 0"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="width:24px;vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">1</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">Complete your profile</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">2</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We will assign you jobs based on your skills and location</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">3</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">You will receive an email for each new job with Accept and Decline options</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">4</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">After completing jobs your tier increases automatically</td></tr>
      </table>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:16px 0 0"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#52525b"><strong>Your login email:</strong> ${esc(email)}</p>
      <p style="margin:4px 0 0;font-size:13px;color:#71717a">Forgot your password? Use the forgot password link on the login page.</p>
    </td></tr></table>

    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Reply to this email.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa">Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}
