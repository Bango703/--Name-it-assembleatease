import { getSupabase } from '../_supabase.js';
import { rateLimitKey } from '../_ratelimit.js';
import { normalizeEmail, verifyCode, getAvailableBalanceCents, issueRedemptionToken } from '../_assemblecash.js';

/**
 * POST /api/assemblecash/verify-code  { email, code }
 * Verifies the one-time code. On success returns the available balance and a
 * short-lived redemption token the booking endpoint re-checks before honoring
 * any credit — so credit can never be seen or spent from a typed email alone.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email: rawEmail, code } = req.body || {};
  const email = normalizeEmail(rawEmail);
  if (!email || !/^\d{6}$/.test(String(code || '').trim())) {
    return res.status(400).json({ error: 'Enter your email and the 6-digit code.' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await rateLimitKey('ac-verify:' + ip, 'setup_intent'))) {
    return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
  }

  const sb = getSupabase();
  let ok = false;
  try {
    ok = await verifyCode(sb, email, code, 'assemblecash');
  } catch (e) {
    console.error('AssembleCash verify-code error:', e && (e.message || e));
    return res.status(500).json({ error: 'Could not verify right now. Please try again shortly.' });
  }
  if (!ok) return res.status(400).json({ error: 'That code is invalid or expired. Request a new one.' });

  const balanceCents = await getAvailableBalanceCents(sb, email);
  const token = issueRedemptionToken(email);
  return res.status(200).json({ ok: true, balanceCents, token });
}
