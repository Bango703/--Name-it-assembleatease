import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadLedgerFirstFinanceRows, summarizeFinanceRows } from './_finance-ledger.js';
import { formatUsPhone } from '../_phone.js';

/**
 * GET /api/owner/payouts
 * Owner-only. Returns per-Easer payout ledger from completed bookings and
 * fee-bearing cancellations that created canonical Easer earnings.
 *
 * Each row:
 *   assembler_id, assembler_name, assembler_tier,
 *   jobs:          count of completed jobs
 *   total_charged: sum of amount_charged (actual captured, cents)
 *   total_owed:    sum of assembler_due (what the platform owes them, cents)
 *   total_paid:    sum where payout_status='paid' (cents)
 *   total_pending: unpaid, non-refunded canonical earnings (cents)
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

  const earningsRows = (finance.rows || []).filter(r => r.assemblerId);

  // Aggregate per Easer
  const byEaser = {};
  for (const b of earningsRows || []) {
    const id = b.assemblerId;
    if (!byEaser[id]) {
      byEaser[id] = {
        assembler_id:   id,
        assembler_name: b.assemblerName || 'Unknown',
        assembler_tier: b.assemblerTier || null,
        jobs:           0,
        cancellation_earnings: 0,
        total_charged:  0,
        total_owed:     0,
        total_paid:     0,
        total_pending:  0,
        total_payable:  0,
        total_on_hold:  0,
        unpaid_jobs:    [],
        last_job_date:  null,
        last_earning_date: null,
        legacy_rows:    0,
      };
    }
    const e = byEaser[id];
    const charged = Number(b.netCharged || 0);
    const owed    = Number(b.owed || 0);
    const paid    = b.paidOut ? Number(b.payoutAmount || 0) : 0;

    if (b.status === 'completed') e.jobs++;
    if (b.cancellationEarnings) e.cancellation_earnings++;
    e.total_charged += charged;
    e.total_owed    += owed;
    e.total_paid    += paid;
    if (b.legacyDerived) e.legacy_rows++;

    if (!b.paidOut && ['pending', 'on_hold'].includes(b.payoutDisposition) && owed > 0) {
      e.total_pending += owed;
      if (b.payoutDisposition === 'on_hold') e.total_on_hold += owed;
      else e.total_payable += owed;
      const eventMs = Date.parse(b.eventAt || b.date || '');
      const ageDays = Number.isFinite(eventMs)
        ? Math.max(0, Math.floor((Date.now() - eventMs) / 86400000))
        : null;
      e.unpaid_jobs.push({
        id: b.bookingId,
        ref: b.ref,
        service: b.service,
        date: b.date,
        event_type: b.eventType,
        event_at: b.eventAt,
        payout_status: b.payoutStatus,
        owed,
        disposition: b.payoutDisposition,
        review_status: b.payoutReviewStatus,
        review_notes: b.payoutReviewNotes,
        payout_mode: b.payoutMode,
        age_days: ageDays,
        source: b.legacyDerived ? 'legacy' : 'ledger',
      });
    }
    if (b.status === 'completed' && (!e.last_job_date || (b.completedAt && b.completedAt > e.last_job_date))) {
      e.last_job_date = b.completedAt || b.date;
    }
    if (!e.last_earning_date || (b.eventAt && b.eventAt > e.last_earning_date)) {
      e.last_earning_date = b.eventAt || b.date;
    }
  }

  const easerIds = Object.keys(byEaser);
  if (easerIds.length) {
    const { data: profiles, error: profileError } = await sb
      .from('profiles')
      .select('id, email, phone, payout_method_preference, account_closure_status')
      .in('id', easerIds);
    if (profileError) {
      console.error('Payout contact lookup error:', profileError);
      return res.status(503).json({
        error: 'Payout amounts loaded, but Easer payment contacts could not be verified.',
        code: 'PAYOUT_CONTACT_TRUTH_UNAVAILABLE',
      });
    }
    (profiles || []).forEach(profile => {
      const easer = byEaser[profile.id];
      if (!easer) return;
      easer.email = profile.email || null;
      easer.phone = formatUsPhone(profile.phone);
      easer.payout_method_preference = profile.payout_method_preference || null;
      easer.account_closure_status = profile.account_closure_status || null;
    });
  }

  const easers = Object.values(byEaser)
    .sort((a, b) => b.total_pending - a.total_pending); // most owed first

  const totals = easers.reduce((acc, e) => ({
    jobs:          acc.jobs          + e.jobs,
    cancellation_earnings: acc.cancellation_earnings + e.cancellation_earnings,
    total_charged: acc.total_charged + e.total_charged,
    total_owed:    acc.total_owed    + e.total_owed,
    total_paid:    acc.total_paid    + e.total_paid,
    total_pending: acc.total_pending + e.total_pending,
    total_payable: acc.total_payable + e.total_payable,
    total_on_hold: acc.total_on_hold + e.total_on_hold,
  }), {
    jobs: 0,
    cancellation_earnings: 0,
    total_charged: 0,
    total_owed: 0,
    total_paid: 0,
    total_pending: 0,
    total_payable: 0,
    total_on_hold: 0,
  });

  const financeTotals = summarizeFinanceRows(finance.rows || []);

  return res.status(200).json({
    easers,
    totals,
    finance_totals: financeTotals,
    reconciliation: finance.reconciliation,
  });
}
