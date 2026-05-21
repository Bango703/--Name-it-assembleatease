import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';

const LOGO = 'https://www.assembleatease.com/images/logo.jpg';
const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/assembler/update
 * Owner-only: manage Easer status, tier, ID verification.
 *
 * CLEAN SEPARATION:
 *   status               — platform access: pending | active | suspended | rejected
 *   tier                 — quality level:   starter | professional | elite
 *   id_verification_status — identity:      pending | verified | failed
 *   has_membership       — subscription (managed by /api/assembler/membership)
 *
 * Actions:
 *   approve          → status=active, tier=starter (requires id_verified=true)
 *   reject           → status=rejected
 *   suspend          → status=suspended, saves previous_tier
 *   reinstate        → status=active, restores previous_tier (not forced to starter)
 *   promote          → tier upgrade (status must be active)
 *   demote           → tier downgrade (status must be active)
 *   mark_id_verified → id_verified=true, id_verification_status=verified
 *   delete           → permanently remove (pending/rejected only)
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { assemblerId, action, tier, rejectionReason } = req.body;
  if (!assemblerId) return res.status(400).json({ error: 'assemblerId is required' });
  if (!action) return res.status(400).json({ error: 'action is required' });

  const sb = getSupabase();

  const { data: profile, error: lookupErr } = await sb
    .from('profiles')
    .select('id, full_name, email, status, tier, identity_verified, id_verification_status, previous_tier, application_status')
    .eq('id', assemblerId)
    .eq('role', 'assembler')
    .maybeSingle();

  if (lookupErr || !profile) return res.status(404).json({ error: 'Easer not found' });

  // ── APPROVE ──────────────────────────────────────────────────────────────
  if (action === 'approve') {
    if (!profile.identity_verified) {
      return res.status(400).json({ error: 'Identity must be verified before approval. Mark ID verified first.' });
    }
    if (profile.status === 'active') {
      return res.status(400).json({ error: 'Easer is already active.' });
    }

    await sb.from('profiles').update({
      status: 'active',
      tier: 'starter',
      application_status: 'approved',
      approved_at: new Date().toISOString(),
      welcome_email_sent: true,
    }).eq('id', assemblerId);

    sb.from('assembler_waitlist').delete().eq('email', profile.email.toLowerCase()).then(() => {});

    let resetUrl = SITE + '/auth/set-password';
    try {
      const { data: linkData } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email: profile.email,
        options: { redirectTo: SITE + '/auth/set-password' },
      });
      if (linkData?.properties?.action_link) resetUrl = linkData.properties.action_link;
    } catch(e) { console.warn('generateLink error:', e.message); }

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Welcome to AssembleAtEase — Set your password to get started',
      replyTo: 'service@assembleatease.com',
      html: buildApprovalEmail(firstName, profile.email, resetUrl),
    }).catch(e => console.error('Approval email error:', e));

    return res.status(200).json({ ok: true, action: 'approved', status: 'active', tier: 'starter' });
  }

  // ── REJECT ───────────────────────────────────────────────────────────────
  if (action === 'reject') {
    if (profile.status === 'active') {
      return res.status(400).json({ error: 'Cannot reject an active Easer. Use suspend instead.' });
    }

    await sb.from('profiles').update({
      status: 'rejected',
      tier: null,
      application_status: 'rejected',
      rejected_at: new Date().toISOString(),
      rejection_reason: rejectionReason?.trim() || null,
    }).eq('id', assemblerId);

    sb.from('assembler_waitlist').update({ status: 'rejected' }).eq('email', profile.email.toLowerCase()).then(() => {});

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your AssembleAtEase Application',
      replyTo: 'service@assembleatease.com',
      html: buildRejectionEmail(firstName, rejectionReason?.trim() || null),
    }).catch(e => console.error('Rejection email error:', e));

    return res.status(200).json({ ok: true, action: 'rejected', status: 'rejected' });
  }

  // ── SUSPEND ──────────────────────────────────────────────────────────────
  if (action === 'suspend') {
    if (profile.status === 'suspended') return res.status(400).json({ error: 'Already suspended.' });
    if (profile.status !== 'active') return res.status(400).json({ error: 'Only active Easers can be suspended.' });

    await sb.from('profiles').update({
      status: 'suspended',
      previous_tier: profile.tier, // preserve so reinstate restores correctly
    }).eq('id', assemblerId);

    return res.status(200).json({ ok: true, action: 'suspended', previous_tier: profile.tier });
  }

  // ── REINSTATE ────────────────────────────────────────────────────────────
  if (action === 'reinstate') {
    if (profile.status !== 'suspended') return res.status(400).json({ error: 'Easer is not suspended.' });

    const restoredTier = profile.previous_tier || 'starter';
    await sb.from('profiles').update({
      status: 'active',
      tier: restoredTier,
      previous_tier: null,
    }).eq('id', assemblerId);

    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const tierLabel = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[restoredTier] || restoredTier;
    sendEmail({
      to: profile.email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: 'Your AssembleAtEase account has been reinstated',
      replyTo: 'service@assembleatease.com',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem"><h2 style="color:#0097a7">Account Reinstated</h2><p>Hi ${esc(firstName)},</p><p>Your account has been reinstated as a <strong>${esc(tierLabel)}</strong> Easer and you can now receive job assignments again.</p><p><a href="${SITE}/assembler/" style="color:#0097a7">Open your dashboard</a></p></div>`,
    }).catch(() => {});

    return res.status(200).json({ ok: true, action: 'reinstated', status: 'active', tier: restoredTier });
  }

  // ── PROMOTE / DEMOTE ─────────────────────────────────────────────────────
  if (action === 'promote' || action === 'demote') {
    if (profile.status !== 'active') {
      return res.status(400).json({ error: 'Only active Easers can have their tier changed.' });
    }

    const validTiers = ['starter', 'professional', 'elite'];
    if (!tier || !validTiers.includes(tier)) {
      return res.status(400).json({ error: 'tier must be one of: starter, professional, elite' });
    }

    const tierRank = { starter: 1, professional: 2, elite: 3 };
    const currentRank = tierRank[profile.tier] || 0;
    const newRank = tierRank[tier];

    if (action === 'promote' && newRank <= currentRank) {
      return res.status(400).json({ error: `Cannot promote to ${tier} — must be higher than current tier (${profile.tier}).` });
    }
    if (action === 'demote' && newRank >= currentRank) {
      return res.status(400).json({ error: `Cannot demote to ${tier} — must be lower than current tier (${profile.tier}).` });
    }

    await sb.from('profiles').update({ tier }).eq('id', assemblerId);

    const tierLabel = { starter: 'Starter', professional: 'Professional', elite: 'Elite' }[tier];
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';

    if (action === 'promote') {
      sendEmail({
        to: profile.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: `You have been promoted to ${tierLabel}`,
        replyTo: 'service@assembleatease.com',
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem"><h2 style="color:#0097a7">Tier Promotion</h2><p>Congratulations, ${esc(firstName)}! You have been promoted to <strong>${esc(tierLabel)}</strong>. This reflects your excellent performance and service quality.</p><p><a href="${SITE}/assembler/" style="color:#0097a7">View your dashboard</a></p></div>`,
      }).catch(() => {});
    }

    return res.status(200).json({ ok: true, action, tier, previous: profile.tier });
  }

  // ── MARK ID VERIFIED ─────────────────────────────────────────────────────
  if (action === 'mark_id_verified') {
    await sb.from('profiles').update({
      identity_verified: true,
      identity_verified_at: new Date().toISOString(),
      id_verification_status: 'verified',
    }).eq('id', assemblerId);

    sendEmail({
      to: ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `ID Verified — ${esc(profile.full_name)} ready to approve`,
      html: `<div style="font-family:sans-serif;padding:1.5rem"><p><strong>${esc(profile.full_name)}</strong> identity manually verified. They can now be approved. <a href="${SITE}/owner/" style="color:#0097a7">Open dashboard</a></p></div>`,
    }).catch(() => {});

    return res.status(200).json({ ok: true, action: 'id_verified', identity_verified: true });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (action === 'delete') {
    if (profile.status === 'active') {
      return res.status(400).json({ error: 'Cannot delete an active Easer. Suspend first.' });
    }

    sb.from('assembler_waitlist').delete().eq('email', profile.email.toLowerCase()).then(() => {});
    const { error: profileDeleteErr } = await sb.from('profiles').delete().eq('id', assemblerId);
    if (profileDeleteErr) return res.status(500).json({ error: 'Failed to delete profile' });
    sb.auth.admin.deleteUser(assemblerId).catch(() => {});

    return res.status(200).json({ ok: true, action: 'deleted' });
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
}

function buildApprovalEmail(firstName, email, resetUrl) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a"><div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;overflow:hidden"><div style="background:linear-gradient(135deg,#003d47,#0097a7);padding:2rem;text-align:center"><img src="${LOGO}" width="44" height="44" style="border-radius:50%;display:inline-block"/><h1 style="color:#fff;margin:12px 0 0;font-size:1.4rem">Welcome to AssembleAtEase!</h1></div><div style="padding:2rem"><p style="font-size:1rem;font-weight:700;margin:0 0 12px">Congratulations, ${esc(firstName)}!</p><p style="color:#52525b;line-height:1.7;margin:0 0 20px">Your application has been approved. You are now an official Starter Easer on AssembleAtEase.</p><p style="color:#52525b;margin:0 0 16px">Click the button below to set your password and access your dashboard:</p><div style="text-align:center;margin:1.5rem 0"><a href="${resetUrl}" style="display:inline-block;background:#0097a7;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:1rem;font-weight:700">Set Password &amp; Open Dashboard</a></div><div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:6px;padding:12px 16px;margin-bottom:20px"><p style="margin:0;font-size:0.82rem;color:#92400e">This link expires in 24 hours. Use <a href="${SITE}/auth/forgot-password" style="color:#92400e">forgot password</a> if it expires.</p></div><p style="font-size:0.85rem;color:#71717a"><strong>Your login:</strong> ${esc(email)}</p></div></div></div></body></html>`;
}

function buildRejectionEmail(firstName, reason) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a"><div style="max-width:600px;margin:0 auto;padding:24px 16px"><div style="background:#fff;border-radius:8px;border:1px solid #e4e4e7;padding:2rem"><img src="${LOGO}" width="36" height="36" style="border-radius:50%;display:block;margin:0 0 1rem"/><p style="font-size:1rem;font-weight:700;margin:0 0 12px">Hi ${esc(firstName)},</p><p style="color:#52525b;line-height:1.7;margin:0 0 16px">Thank you for your interest in AssembleAtEase. After careful review, we are not able to move forward with your application at this time.</p>${reason ? `<div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;padding:14px 18px;margin-bottom:16px"><p style="margin:0;font-size:0.875rem;color:#52525b"><strong>Feedback:</strong> ${esc(reason)}</p></div>` : ''}<p style="color:#52525b;line-height:1.7">You are welcome to reapply after 90 days. Questions? <a href="mailto:service@assembleatease.com" style="color:#0097a7">service@assembleatease.com</a></p></div></div></body></html>`;
}
