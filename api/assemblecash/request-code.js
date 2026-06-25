import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { rateLimitKey } from '../_ratelimit.js';
import { isValidPromoEmail } from '../_promotions.js';
import { normalizeEmail, generateAndStoreCode, ASSEMBLECASH } from '../_assemblecash.js';

/**
 * POST /api/assemblecash/request-code  { email }
 * Emails a one-time 6-digit code so the customer can prove they own the inbox
 * before any AssembleCash balance is shown or spent. Always returns a generic
 * success so an email's balance status can never be enumerated from this route.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const email = normalizeEmail((req.body || {}).email);
  if (!isValidPromoEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const okEmail = await rateLimitKey('ac-code:' + email, 'setup_intent_email');
  const okIp = await rateLimitKey('ac-code:' + ip, 'setup_intent');
  if (!okEmail || !okIp) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
  }

  const sb = getSupabase();
  let code = null;
  try {
    code = await generateAndStoreCode(sb, email, 'assemblecash');
  } catch (e) {
    // Missing table / DB error — stay generic, never leak details.
    console.error('AssembleCash request-code error:', e && (e.message || e));
    return res.status(200).json({ ok: true });
  }

  try {
    await sendEmail({
      to: email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your AssembleCash code: ${code}`,
      replyTo: ownerEmail(),
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;background:#f4f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0d2430">
<div style="max-width:480px;margin:0 auto;padding:28px 18px">
  <div style="background:#fff;border:1px solid #e5edf0;border-radius:14px;padding:28px 26px;text-align:center">
    <p style="margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0094c6">AssembleCash</p>
    <p style="margin:0 0 18px;font-size:15px;color:#5b6b73">Use this code to view or apply your AssembleCash balance:</p>
    <div style="font-size:34px;font-weight:800;letter-spacing:7px;color:#0d2430;background:#f6fafb;border:1px solid #e5edf0;border-radius:10px;padding:14px 0">${esc(code)}</div>
    <p style="margin:18px 0 0;font-size:13px;color:#73828a">This code expires in ${ASSEMBLECASH.CODE_TTL_MIN} minutes. If you didn't request it, you can ignore this email.</p>
  </div>
  <p style="text-align:center;margin:14px 0 0;font-size:12px;color:#9aa7ad">AssembleCash is future-booking credit. It has no cash value and cannot be withdrawn.</p>
</div></body></html>`,
    });
  } catch (e) {
    console.error('AssembleCash code email error:', e && (e.message || e));
  }

  return res.status(200).json({ ok: true });
}
