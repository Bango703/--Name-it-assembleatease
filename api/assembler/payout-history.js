import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';

/**
 * GET /api/assembler/payout-history
 * Authenticated assembler payout history using payout_ledger as source of truth,
 * with legacy fallback for completed jobs that predate ledger rows.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const token = auth.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await userClient.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid token' });

  const sb = getSupabase();

  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!profile || profile.role !== 'assembler') return res.status(403).json({ error: 'Forbidden' });

  const { data: bookings, error: bookingsErr } = await sb
    .from('bookings')
    .select('id, ref, service, completed_at, date, amount_charged, total_price, assembler_due, platform_fee, platform_fee_pct, payout_status, payout_amount, paid_out_at')
    .eq('assembler_id', user.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  if (bookingsErr) {
    console.error('payout-history bookings error:', bookingsErr);
    return res.status(500).json({ error: 'Failed to load payout history' });
  }

  const completed = bookings || [];
  if (!completed.length) {
    return res.status(200).json({ entries: [], summary: { jobs: 0, total_earned: 0, total_paid: 0, total_pending: 0 }, reconciliation: { ledger_backed: 0, legacy_derived: 0 } });
  }

  const bookingIds = completed.map(b => b.id).filter(Boolean);
  let ledgerRows = [];

  if (bookingIds.length) {
    const { data, error } = await sb
      .from('payout_ledger')
      .select('booking_id, booking_ref, service, booking_date, amount_charged, assembler_due, payout_amount, platform_revenue, recorded_at')
      .eq('assembler_id', user.id)
      .in('booking_id', bookingIds)
      .order('recorded_at', { ascending: false });

    if (error) {
      console.error('payout-history ledger error:', error);
      return res.status(500).json({ error: 'Failed to load payout history' });
    }

    ledgerRows = data || [];
  }

  const ledgerByBooking = new Map();
  for (const row of ledgerRows) {
    if (!row.booking_id) continue;
    if (!ledgerByBooking.has(row.booking_id)) ledgerByBooking.set(row.booking_id, row);
  }

  const entries = completed.map(b => {
    const ledger = ledgerByBooking.get(b.id) || null;

    const effectiveDue = ledger
      ? Number(ledger.payout_amount || 0)
      : Number(b.assembler_due || b.payout_amount || 0);

    const isPaid = ledger ? true : (b.payout_status === 'paid' || Number(b.payout_amount || 0) > 0);

    return {
      booking_id: b.id,
      booking_ref: ledger?.booking_ref || b.ref,
      service: ledger?.service || b.service,
      completed_at: b.completed_at,
      booking_date: ledger?.booking_date || b.date,
      amount_charged: ledger ? Number(ledger.amount_charged || 0) : Number(b.amount_charged || b.total_price || 0),
      assembler_due: ledger ? Number(ledger.assembler_due || 0) : Number(b.assembler_due || 0),
      payout_amount: effectiveDue,
      payout_status: isPaid ? 'paid' : 'pending',
      paid_out_at: ledger?.recorded_at || b.paid_out_at || null,
      platform_fee: Number(b.platform_fee || 0),
      platform_fee_pct: Number(b.platform_fee_pct || 0),
      source: ledger ? 'ledger' : 'legacy',
    };
  });

  const summary = entries.reduce((acc, e) => {
    acc.jobs += 1;
    acc.total_earned += Number(e.payout_amount || 0);
    if (e.payout_status === 'paid') acc.total_paid += Number(e.payout_amount || 0);
    else acc.total_pending += Number(e.payout_amount || 0);
    return acc;
  }, { jobs: 0, total_earned: 0, total_paid: 0, total_pending: 0 });

  return res.status(200).json({
    entries,
    summary,
    reconciliation: {
      ledger_backed: entries.filter(e => e.source === 'ledger').length,
      legacy_derived: entries.filter(e => e.source === 'legacy').length,
    },
  });
}
