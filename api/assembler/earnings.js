import { authenticateBearerUser, respondWithEaserAccessError } from '../_easer-access.js';
import { normalizeEaserClosureStatus } from '../_easer-closure.js';
import { getSupabase } from '../_supabase.js';
import { loadLedgerFirstFinanceRows } from '../owner/_finance-ledger.js';
import { summarizeEaserEarnings, toEaserEarningDto } from './_earnings.js';

/**
 * GET /api/assembler/earnings
 * Read-only financial history for the authenticated Easer. This endpoint is
 * intentionally separate from assigned-work access so suspended Easers and
 * closure requests under review can still reconcile their own earnings.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'private, no-store');

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role, account_closure_status')
    .eq('id', authenticated.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[assembler-earnings] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({
      error: 'Earnings access could not be verified. Please retry.',
      code: 'EARNINGS_PROFILE_LOOKUP_FAILED',
    });
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'Easer access required' });
  }
  if (normalizeEaserClosureStatus(profile) === 'completed') {
    return res.status(403).json({
      error: 'This Easer account is closed. Contact support for retained payout records.',
      code: 'EASER_ACCOUNT_CLOSED',
    });
  }

  let finance;
  try {
    finance = await loadLedgerFirstFinanceRows(sb, { assemblerId: authenticated.user.id });
  } catch (error) {
    console.error('[assembler-earnings] Canonical finance load failed:', error.message || error);
    return res.status(503).json({
      error: 'Current payout status could not be verified. Please retry before relying on an amount or status.',
      code: error.code === 'MIGRATION_REQUIRED' ? 'EARNINGS_MIGRATION_REQUIRED' : 'EARNINGS_TRUTH_UNAVAILABLE',
    });
  }

  const earnings = (finance.rows || [])
    .filter(row => row.assemblerId === authenticated.user.id)
    .map(toEaserEarningDto)
    .sort((a, b) => Date.parse(b.earned_at || 0) - Date.parse(a.earned_at || 0));

  return res.status(200).json({
    earnings,
    summary: summarizeEaserEarnings(earnings),
  });
}
