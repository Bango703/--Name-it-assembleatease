import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

// Sales Tax Liability report (read-only) + owner-entered remittance tracking.
// Does NOT change tax calculation, taxability, or the 8.25% rate — it only
// reports what was already collected and lets the owner record remittances.
//
// Basis: tax is COLLECTED on the payment-capture date (a card hold that is never
// captured collects no tax). Refunds REDUCE liability on the refund date, using
// the proportional tax of the refunded amount. Sales tax is a pass-through
// liability owed to the Texas Comptroller — never platform revenue.

const STATE_RATE = 0.0625;     // Texas state portion
const COMBINED_RATE = 0.0825;  // state 6.25% + local 2.00%

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();

  if (req.method === 'POST') return recordRemittance(req, res, sb);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const granularity = String(req.query.granularity || 'month').toLowerCase() === 'quarter' ? 'quarter' : 'month';

  let bookings = [];
  try {
    const { data, error } = await sb
      .from('bookings')
      .select('id, ref, tax_amount, amount_charged, total_price, payment_status, payment_captured_at, refunded_at, refund_amount')
      .not('payment_captured_at', 'is', null)
      .limit(5000);
    if (error) throw error;
    bookings = data || [];
  } catch (e) {
    console.error('Tax report bookings load error:', e?.message || e);
    return res.status(500).json({ error: 'Failed to load tax data' });
  }

  const periods = new Map();
  const bucket = (key) => {
    if (!periods.has(key)) periods.set(key, { period: key, taxableSalesCents: 0, taxCollectedCents: 0, taxRefundedCents: 0 });
    return periods.get(key);
  };
  const periodKey = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return granularity === 'quarter' ? `${y}-Q${Math.floor(m / 3) + 1}` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };

  for (const b of bookings) {
    const tax = Math.max(0, Number(b.tax_amount || 0));
    const charged = Number(b.amount_charged || b.total_price || 0);
    const ck = periodKey(b.payment_captured_at);
    if (ck) {
      const row = bucket(ck);
      row.taxCollectedCents += tax;
      row.taxableSalesCents += Math.max(0, charged - tax);
    }
    const refundAmt = Number(b.refund_amount || 0);
    if (b.refunded_at && refundAmt > 0 && charged > 0) {
      const rk = periodKey(b.refunded_at);
      if (rk) {
        const refundTax = Math.round(tax * Math.min(refundAmt, charged) / charged);
        bucket(rk).taxRefundedCents += refundTax;
      }
    }
  }

  const remittedByPeriod = new Map();
  let remittancesAvailable = true;
  let remittances = [];
  try {
    const { data, error } = await sb
      .from('tax_remittances')
      .select('id, jurisdiction, filing_period, amount_cents, date_remitted, reference, notes, created_at')
      .order('date_remitted', { ascending: false })
      .limit(500);
    if (error) {
      remittancesAvailable = false;
    } else {
      remittances = data || [];
      for (const r of remittances) {
        remittedByPeriod.set(r.filing_period, (remittedByPeriod.get(r.filing_period) || 0) + Number(r.amount_cents || 0));
      }
    }
  } catch (e) {
    remittancesAvailable = false;
  }

  const result = Array.from(periods.values()).map((p) => {
    const netLiabilityCents = p.taxCollectedCents - p.taxRefundedCents;
    const statePortionCents = Math.round(netLiabilityCents * STATE_RATE / COMBINED_RATE);
    const localPortionCents = netLiabilityCents - statePortionCents;
    const remittedCents = remittedByPeriod.get(p.period) || 0;
    return {
      period: p.period,
      taxableSalesCents: p.taxableSalesCents,
      taxCollectedCents: p.taxCollectedCents,
      taxRefundedCents: p.taxRefundedCents,
      netLiabilityCents,
      statePortionCents,
      localPortionCents,
      remittedCents,
      outstandingCents: netLiabilityCents - remittedCents,
    };
  }).sort((a, b) => b.period.localeCompare(a.period));

  const totals = result.reduce((t, p) => ({
    taxableSalesCents: t.taxableSalesCents + p.taxableSalesCents,
    taxCollectedCents: t.taxCollectedCents + p.taxCollectedCents,
    taxRefundedCents: t.taxRefundedCents + p.taxRefundedCents,
    netLiabilityCents: t.netLiabilityCents + p.netLiabilityCents,
    remittedCents: t.remittedCents + p.remittedCents,
    outstandingCents: t.outstandingCents + p.outstandingCents,
  }), { taxableSalesCents: 0, taxCollectedCents: 0, taxRefundedCents: 0, netLiabilityCents: 0, remittedCents: 0, outstandingCents: 0 });

  return res.status(200).json({
    granularity,
    rateLabel: '8.25% (TX state 6.25% + local 2.00%)',
    basis: 'Collected on payment-capture date; refunds reduce liability on refund date. Pass-through liability owed to the Texas Comptroller — never platform revenue.',
    remittancesAvailable,
    periods: result,
    totals,
    remittances: remittancesAvailable ? remittances : [],
  });
}

async function recordRemittance(req, res, sb) {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const filingPeriod = String(b.filingPeriod || '').trim();
  const amountCents = b.amountCents != null ? parseInt(b.amountCents, 10) : Math.round(Number(b.amountDollars || 0) * 100);
  const dateRemitted = String(b.dateRemitted || '').trim();

  if (!filingPeriod) return res.status(400).json({ error: 'Filing period is required' });
  if (!Number.isFinite(amountCents) || amountCents < 0) return res.status(400).json({ error: 'A valid remittance amount is required' });
  if (!dateRemitted) return res.status(400).json({ error: 'Remittance date is required' });

  try {
    const { data, error } = await sb.from('tax_remittances').insert({
      jurisdiction: String(b.jurisdiction || 'TX').slice(0, 20),
      filing_period: filingPeriod.slice(0, 20),
      amount_cents: amountCents,
      date_remitted: dateRemitted,
      reference: b.reference ? String(b.reference).slice(0, 200) : null,
      notes: b.notes ? String(b.notes).slice(0, 1000) : null,
      recorded_by: 'owner',
    }).select('id').single();

    if (error) {
      console.error('Tax remittance insert error:', error.message || error);
      if (/tax_remittances/i.test(error.message || '') || error.code === '42P01') {
        return res.status(503).json({ error: 'Remittance tracking is not enabled yet. Run migration 022_tax_remittances.sql.', code: 'MIGRATION_REQUIRED' });
      }
      return res.status(500).json({ error: 'Failed to record remittance' });
    }
    return res.status(200).json({ success: true, id: data.id });
  } catch (e) {
    console.error('Tax remittance error:', e?.message || e);
    return res.status(500).json({ error: 'Failed to record remittance' });
  }
}
