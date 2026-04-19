import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/assembler/update
 * Owner-only: update assembler tier, suspend/reactivate, or reject.
 * Body: { assemblerId, tier?, suspended?, action? }
 * action: 'reject' | undefined (use tier/suspended for other updates)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId, tier, suspended, action, rejectionReason } = req.body;
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

  // ── Handle rejection ──
  if (action === 'reject') {
    const { error: rejectErr } = await sb
      .from('profiles')
      .update({
        tier: 'pending', // keep pending, won't be approved
        application_status: 'rejected',
        rejected_at: new Date().toISOString(),
        rejection_reason: rejectionReason?.trim() || null,
      })
      .eq('id', assemblerId);

    if (rejectErr) {
      // Try without new columns if they don't exist yet
      await sb.from('profiles').update({ tier: 'pending' }).eq('id', assemblerId);
    }

    // Update waitlist status
    try {
      await sb.from('assembler_waitlist')
        .update({ status: 'rejected' })
        .eq('email', profile.email.toLowerCase());
    } catch (e) { console.error('Waitlist reject update error:', e); }

    // Send rejection email
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Your AssembleAtEase Application',
        replyTo: 'service@assembleatease.com',
        html: buildRejectionEmail(firstName, rejectionReason?.trim() || null),
      });
    } catch (e) { console.error('Rejection email error:', e); }

    return res.status(200).json({ success: true, assemblerId, action: 'rejected' });
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

  // ── If approving (pending → starter/verified/elite), send welcome email with password reset link ──
  if (tier && tier !== 'pending' && profile.tier === 'pending') {
    // Update waitlist status to approved
    try {
      await sb.from('assembler_waitlist')
        .update({ status: 'approved' })
        .eq('email', profile.email.toLowerCase());
    } catch (e) { console.error('Waitlist approve update error:', e); }

    // Generate password reset link — assembler uses this to set their own password
    let resetUrl = SITE + '/auth/set-password';
    try {
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email: profile.email,
        options: { redirectTo: SITE + '/auth/set-password' },
      });
      if (!linkErr && linkData?.properties?.action_link) {
        resetUrl = linkData.properties.action_link;
      } else {
        console.warn('generateLink warning:', linkErr?.message);
      }
    } catch (e) { console.error('generateLink error:', e); }

    // Update application status (non-blocking — columns may not exist yet)
    sb.from('profiles').update({
      application_status: 'approved',
      approved_at: new Date().toISOString(),
      welcome_email_sent: true,
    }).eq('id', assemblerId).then(({ error: e }) => {
      if (e) console.warn('application_status update skipped:', e.message);
    });

    // Send welcome email with password reset link
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    try {
      await sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Welcome to AssembleAtEase — Set your password to get started',
        replyTo: 'service@assembleatease.com',
        html: buildWelcomeEmail(firstName, profile.email, tier, resetUrl),
      });
    } catch (e) { console.error('Welcome email error:', e); }
  }

  return res.status(200).json({ success: true, assemblerId, updates });
}

function buildWelcomeEmail(firstName, email, tier, resetUrl) {
  var tierLabel = { starter: 'Starter', verified: 'Verified', elite: 'Elite' }[tier] || tier;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#1a1a1a">Congratulations, ${esc(firstName)}!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#52525b;line-height:1.7">Your application has been approved. You are now an official <strong>AssembleAtEase</strong> assembler at the <strong>${esc(tierLabel)}</strong> tier.</p>

    <p style="margin:0 0 12px;font-size:15px;color:#52525b;line-height:1.7">Click the button below to set your password and access your dashboard:</p>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center;padding:8px 0 20px">
      <a href="${resetUrl}" style="display:inline-block;background:#0097a7;color:#ffffff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:700">Set Password &amp; Open Dashboard &rarr;</a>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;margin-bottom:24px"><tr><td style="padding:12px 16px">
      <p style="margin:0;font-size:13px;color:#92400e">&#9888; This link expires in 24 hours. If it expires, use the <a href="${SITE}/auth/forgot-password" style="color:#92400e">forgot password</a> page to get a new one.</p>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin:0 0 16px"><tr><td style="padding:18px 20px">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#71717a">What happens next</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="width:24px;vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">1</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">Set your password using the button above</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">2</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">Complete your profile on the dashboard</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">3</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">We will assign you jobs based on your skills and location</td></tr>
        <tr><td style="vertical-align:top;padding:4px 0"><div style="width:20px;height:20px;background:#0097a7;border-radius:50%;text-align:center;line-height:20px;font-size:10px;font-weight:700;color:#fff">4</div></td><td style="padding:4px 0 4px 10px;font-size:14px;color:#52525b;line-height:1.5">You will receive email notifications for each new job opportunity</td></tr>
      </table>
    </td></tr></table>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px"><tr><td style="padding:14px 18px">
      <p style="margin:0;font-size:13px;color:#52525b"><strong>Your login email:</strong> ${esc(email)}</p>
    </td></tr></table>

    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Reply to this email or contact <a href="mailto:service@assembleatease.com" style="color:#0097a7;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa">Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}

function buildRejectionEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px 8px 0 0;border-bottom:1px solid #e4e4e7"><tr><td style="padding:24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="44" height="44" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 0;font-size:17px;font-weight:700;color:#1a1a1a">AssembleAtEase</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7"><tr><td style="padding:32px 24px 24px">
    <p style="margin:0 0 16px;font-size:22px;font-weight:700;color:#1a1a1a">Hi ${esc(firstName)},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">
      Thank you for your interest in joining AssembleAtEase and for taking the time to apply. We appreciate you going through the application process.
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">
      After careful review, we are not able to move forward with your application at this time. This decision is not a reflection of your worth or abilities — we receive many strong applications and can only accept a limited number of assemblers in each area.
    </p>
    ${reason ? `<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;margin-bottom:20px"><tr><td style="padding:14px 18px"><p style="margin:0;font-size:14px;color:#52525b;line-height:1.6"><strong>Feedback:</strong> ${esc(reason)}</p></td></tr></table>` : ''}
    <p style="margin:0 0 16px;font-size:15px;color:#52525b;line-height:1.7">
      You are welcome to reapply after 90 days if your situation changes. We wish you the very best.
    </p>
    <p style="margin:20px 0 0;font-size:13px;color:#52525b;line-height:1.6">Questions? Contact us at <a href="mailto:service@assembleatease.com" style="color:#0097a7;text-decoration:none">service@assembleatease.com</a>.</p>
  </td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px"><tr><td style="padding:20px 24px;text-align:center">
    <img src="${LOGO}" alt="AssembleAtEase" width="28" height="28" style="border-radius:50%;display:inline-block"/>
    <p style="margin:8px 0 4px;font-size:12px;font-weight:600;color:#71717a">AssembleAtEase</p>
    <p style="margin:0;font-size:11px;color:#a1a1aa">Austin, TX &bull; <a href="mailto:service@assembleatease.com" style="color:#71717a;text-decoration:none">service@assembleatease.com</a></p>
  </td></tr></table>
</div></body></html>`;
}
