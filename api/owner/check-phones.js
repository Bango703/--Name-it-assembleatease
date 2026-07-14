import { getSupabase } from '../_supabase.js';
import { verifyOwner, sendEmail, ownerEmail, esc } from '../_email.js';
import { normalizeUsPhone } from '../_phone.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/owner/check-phones
 * Finds all Easers missing a valid U.S. phone number and emails them to update their profile.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { data: easers, error: easerLookupError } = await sb
    .from('profiles')
    .select('id, full_name, email, phone')
    .eq('role', 'assembler')
    .in('tier', ['starter', 'professional', 'elite']);

  if (easerLookupError) {
    console.error('Phone readiness lookup error:', easerLookupError);
    return res.status(503).json({ error: 'Phone readiness could not be checked. No emails were sent.' });
  }

  const easersNeedingPhone = (easers || []).filter(easer => !normalizeUsPhone(easer.phone));

  if (!easersNeedingPhone.length) {
    return res.status(200).json({ sent: 0, message: 'All Easers have a valid 10-digit U.S. phone number on file' });
  }

  let sent = 0;
  let suppressed = 0;
  let failed = 0;
  for (const e of easersNeedingPhone) {
    try {
      const emailResult = await sendEmail({
        to: e.email,
        from: 'AssembleAtEase <booking@assembleatease.com>',
        subject: 'Action Required — Add Your Phone Number',
        replyTo: ownerEmail(),
        meta: { notificationType: 'easer_phone_required', recipientType: 'easer', recipientUserId: e.id },
        html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;padding:20px 16px">
  <div style="background:#fff;border-radius:14px;padding:2rem;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
    <h2 style="margin:0 0 0.5rem;font-size:1.25rem;color:#111">Hi ${esc((e.full_name||'').split(' ')[0])},</h2>
    <p style="color:#374151;line-height:1.7;margin:0 0 1rem">We need a valid 10-digit U.S. phone number on file to assign you jobs and reach you for time-sensitive coordination.</p>
    <p style="color:#374151;line-height:1.7;margin:0 0 1.5rem"><strong>This is required</strong> — Easers without a valid phone number on file will not receive job assignments.</p>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="text-align:center">
      <a href="${SITE}/assembler/profile" style="display:inline-block;background:#00BFFF;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:1rem;font-weight:700">Update My Profile →</a>
    </td></tr></table>
    <p style="margin:1.5rem 0 0;font-size:0.82rem;color:#9ca3af;text-align:center">Questions? Email <a href="mailto:service@assembleatease.com" style="color:#00BFFF;text-decoration:none">service@assembleatease.com</a></p>
  </div>
</div></body></html>`,
      });
      if (emailResult?.ok === true && !emailResult.suppressed) sent++;
      else if (emailResult?.suppressed) suppressed++;
      else failed++;
    } catch(e) {
      failed++;
      console.error('Phone nudge email error:', e);
    }
  }

  return res.status(200).json({
    sent,
    suppressed,
    failed,
    total: easersNeedingPhone.length,
    missing: easersNeedingPhone.map(e => e.email),
    message: failed > 0
      ? `${failed} phone request email${failed === 1 ? '' : 's'} failed. Review notification logs and retry.`
      : suppressed > 0 && sent === 0
        ? 'Phone update requests were already sent recently; duplicate emails were suppressed.'
        : `${sent} phone update request${sent === 1 ? '' : 's'} sent.`,
  });
}
