import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadLedgerFirstFinanceRows, summarizeFinanceRows } from './_finance-ledger.js';

/**
 * GET /api/owner/payouts
 * Owner-only. Returns per-Easer payout ledger from completed bookings.
 *
 * Each row:
 *   assembler_id, assembler_name, assembler_tier,
 *   jobs:          count of completed jobs
 *   total_charged: sum of amount_charged (actual captured, cents)
 *   total_owed:    sum of assembler_due (what the platform owes them, cents)
 *   total_paid:    sum where payout_status='paid' (cents)
 *   total_pending: total_owed - total_paid (cents)
 *   last_job_date: most recent completed_at
 *
 * Also returns a summary of unpaid jobs (with booking refs) for quick action.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  let finance;
  try {
    finance = await loadLedgerFirstFinanceRows(sb);
  } catch (error) {
    console.error('Payouts ledger-first load error:', error);
    return res.status(500).json({ error: 'Failed to load payout data' });
  }

  const completed = (finance.rows || []).filter(r => r.assemblerId);

  // Aggregate per Easer
  const byEaser = {};
  for (const b of completed || []) {
    const id = b.assemblerId;
    if (!byEaser[id]) {
      byEaser[id] = {
        assembler_id:   id,
        assembler_name: b.assemblerName || 'Unknown',
        assembler_tier: b.assemblerTier || null,
        jobs:           0,
        total_charged:  0,
        total_owed:     0,
        total_paid:     0,
        unpaid_jobs:    [],
        last_job_date:  null,
        legacy_rows:    0,
      };
    }
    const e = byEaser[id];
    const charged = Number(b.netCharged || 0);
    const owed    = Number(b.owed || 0);
    const paid    = b.paidOut ? Number(b.payoutAmount || 0) : 0;

    e.jobs++;
    e.total_charged += charged;
    e.total_owed    += owed;
    e.total_paid    += paid;
    if (b.legacyDerived) e.legacy_rows++;

    if (!b.paidOut && !b.isRefunded && owed > 0) {
      e.unpaid_jobs.push({
        id: b.bookingId,
        ref: b.ref,
        service: b.service,
        date: b.date,
        owed,
        source: b.legacyDerived ? 'legacy' : 'ledger',
      });
    }
    if (!e.last_job_date || (b.completedAt && b.completedAt > e.last_job_date)) {
      e.last_job_date = b.completedAt || b.date;
    }
  }

  const easers = Object.values(byEaser)
    .map(e => ({ ...e, total_pending: e.total_owed - e.total_paid }))
    .sort((a, b) => b.total_pending - a.total_pending); // most owed first

  const totals = easers.reduce((acc, e) => ({
    jobs:          acc.jobs          + e.jobs,
    total_charged: acc.total_charged + e.total_charged,
    total_owed:    acc.total_owed    + e.total_owed,
    total_paid:    acc.total_paid    + e.total_paid,
    total_pending: acc.total_pending + e.total_pending,
  }), { jobs:0, total_charged:0, total_owed:0, total_paid:0, total_pending:0 });

  const financeTotals = summarizeFinanceRows(finance.rows || []);

  return res.status(200).json({
    easers,
    totals,
    finance_totals: financeTotals,
    reconciliation: finance.reconciliation,
  });
}
