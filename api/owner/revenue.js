import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

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

  let query = sb
    .from('bookings')
    .select('amount_charged, payout_amount, platform_fee, assembler_due, platform_revenue, completed_at, payout_status, status')
    .eq('status', 'completed');

  if (from) query = query.gte('completed_at', from);
  if (to) query = query.lte('completed_at', to + 'T23:59:59Z');

  const { data, error } = await query;
  if (error) {
    console.error('Revenue query error:', error);
    return res.status(500).json({ error: 'Failed to fetch revenue data' });
  }

  const rows = data || [];
  let totalCharged = 0;
  let totalPaidOut = 0;
  let totalPlatformRevenue = 0;
  let pendingPayouts = 0;
  let paidOutJobs = 0;
  let pendingJobs = 0;

  for (const b of rows) {
    const charged = b.amount_charged || 0;
    const paid = b.payout_amount || 0;
    totalCharged += charged;
    totalPaidOut += paid;

    const isPaidOut = b.payout_status === 'paid' || paid > 0;
    if (isPaidOut) {
      paidOutJobs++;
      // Use stored platform_revenue; otherwise derive from charged - paid
      totalPlatformRevenue += b.platform_revenue != null ? b.platform_revenue : (charged - paid);
    } else {
      pendingJobs++;
      // Use stored platform_fee; otherwise derive from stored platform_fee_pct or env default
      if (b.platform_fee != null) {
        totalPlatformRevenue += b.platform_fee;
        pendingPayouts += b.assembler_due != null ? b.assembler_due : (charged - b.platform_fee);
      } else {
        const PLATFORM_FEE_PCT = Math.min(100, Math.max(0, parseInt(process.env.PLATFORM_FEE_PCT || '20')));
        const fee = Math.round(charged * PLATFORM_FEE_PCT / 100);
        totalPlatformRevenue += fee;
        pendingPayouts += charged - fee;
      }
    }
  }

  return res.status(200).json({
    completedJobs: rows.length,
    paidOutJobs,
    pendingJobs,
    totalCharged,
    totalPaidOut,
    totalPlatformRevenue,
    pendingPayouts,
    // Human-readable display values
    display: {
      totalCharged: `$${(totalCharged / 100).toFixed(2)}`,
      totalPaidOut: `$${(totalPaidOut / 100).toFixed(2)}`,
      totalPlatformRevenue: `$${(totalPlatformRevenue / 100).toFixed(2)}`,
      pendingPayouts: `$${(pendingPayouts / 100).toFixed(2)}`,
    },
  });
}
