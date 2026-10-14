import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { customerAccountUser } from '../booking/_customer-access.js';
import { logActivity } from '../booking/_activity.js';
import { getAvailableBalanceCents, issueRedemptionToken } from '../_assemblecash.js';

/**
 * GET /api/customer/account — the signed-in customer's AssembleCash balance,
 * and the redemption token checkout passes to apply it. The app's sign-in
 * proved the email the same way the website's AssembleCash code does
 * (api/assemblecash/verify-code.js), so the token is issued from the session.
 *
 * DELETE /api/customer/account — the customer app's Delete account.
 *
 * App Store Guideline 5.1.1(v): an app that creates accounts lets people delete
 * them in the app. This removes the sign-in only. Bookings are business and tax
 * records and stay; the customer can still open them from the emailed link,
 * and signing in again with the same email creates a new account that sees them.
 *
 * Only a customer account can be deleted here, never an Easer's or the owner's.
 */
const STAFF_ROLES = new Set(['assembler', 'admin', 'owner']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return accountSummary(req, res);
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await rateLimit(ip, 'booking'))) return res.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });

  const sb = getSupabase();
  const user = await customerAccountUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to delete your account.' });

  const metadataRole = String(user.user_metadata?.role || user.app_metadata?.role || '').toLowerCase();
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (STAFF_ROLES.has(metadataRole) || STAFF_ROLES.has(String(profile?.role || '').toLowerCase())) {
    return res.status(409).json({ error: 'This account is managed in the Easer app.' });
  }

  const { error } = await sb.auth.admin.deleteUser(user.id);
  if (error) {
    console.error('[customer-account] delete failed:', error.message || error);
    return res.status(503).json({ error: 'Your account could not be deleted right now. Try again in a minute.' });
  }
  await logActivity(sb, {
    bookingId: null,
    eventType: 'customer_account_deleted',
    actorType: 'customer',
    actorId: user.id,
    actorName: 'Customer',
    description: 'A customer deleted their app account. Their bookings are kept.',
    metadata: { userId: user.id },
  }).catch(() => {});
  return res.status(200).json({ ok: true });
}

async function accountSummary(req, res) {
  const sb = getSupabase();
  const user = await customerAccountUser(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to see your account.' });
  const email = String(user.email || '').trim().toLowerCase();
  const balanceCents = await getAvailableBalanceCents(sb, email);
  return res.status(200).json({
    email,
    assemblecash: {
      balance_cents: balanceCents,
      token: balanceCents > 0 ? issueRedemptionToken(email) : null,
    },
  });
}
