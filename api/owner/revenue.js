import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadLedgerFirstFinanceRows, summarizeFinanceRows } from './_finance-ledger.js';

/**
 * GET /api/owner/revenue
 * Owner-only: aggregate revenue and payout stats.
 *
 * Query params:
 *   from  — ISO date string, e.g. 2026-01-01  (filter completed_at >=)
 *   to    — ISO date string, e.g. 2026-12-31  (filter completed_at <=)
 *
 * Response:
 *   completedJobs        — total completed bookings in range
 *   totalCharged         — total collected from customers (cents)
 *   totalPaidOut         — total paid to assemblers (cents)
 *   totalPlatformRevenue — company keeps: totalCharged - totalPaidOut (cents)
 *   pendingPayouts       — assembler_due sum for completed-but-not-yet-paid jobs (cents)
 *   paidOutJobs          — count of jobs with payout recorded
 *   pendingJobs          — count of completed jobs awaiting payout
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const { from, to } = req.query;

  let finance;
  try {
    finance = await loadLedgerFirstFinanceRows(sb, { from, to });
  } catch (error) {
    console.error('Revenue ledger-first load error:', error);
    return res.status(500).json({ error: 'Failed to fetch revenue data' });
  }

  const totals = summarizeFinanceRows(finance.rows || []);

  return res.status(200).json({
    completedJobs: totals.completedJobs,
    paidOutJobs: totals.paidOutJobs,
    pendingJobs: totals.pendingJobs,
    totalCharged: totals.totalCharged,
    totalPaidOut: totals.totalPaidOut,
    totalPlatformRevenue: totals.totalPlatformRevenue,
    pendingPayouts: totals.pendingPayouts,
    reconciliation: finance.reconciliation,
    // Human-readable display values
    display: {
      totalCharged: `$${(totals.totalCharged / 100).toFixed(2)}`,
      totalPaidOut: `$${(totals.totalPaidOut / 100).toFixed(2)}`,
      totalPlatformRevenue: `$${(totals.totalPlatformRevenue / 100).toFixed(2)}`,
      pendingPayouts: `$${(totals.pendingPayouts / 100).toFixed(2)}`,
    },
  });
}
