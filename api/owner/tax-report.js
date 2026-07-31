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
      .select('id, ref, source, status, tax_amount, amount_charged, total_price, payment_status, payment_captured_at, payment_collected, payment_collected_at, completed_at, refunded_at, refund_amount')
      .limit(5000);
    if (error) throw error;
    bookings = data || [];
  } catch (e) {
    console.error('Tax report bookings load error:', e?.message || e);
    return res.status(500).json({ error: 'Failed to load tax data' });
  }

  const periods = new Map();
  const bucket = (key) => {
    if (!periods.has(key)) periods.set(key, {
      period: key,
      taxableSalesCents: 0,
      taxableSalesRefundedCents: 0,
      taxCollectedCents: 0,
      taxRefundedCents: 0,
    });
    return periods.get(key);
  };
  const periodKey = (dateStr) => {
    if (!dateStr) return null;
    const raw = String(dateStr);
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00-05:00` : raw);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(d);
    const y = Number(parts.find(part => part.type === 'year')?.value);
    const m = Number(parts.find(part => part.type === 'month')?.value);
    if (!Number.isInteger(y) || !Number.isInteger(m)) return null;
    return granularity === 'quarter' ? `${y}-Q${Math.floor((m - 1) / 3) + 1}` : `${y}-${String(m).padStart(2, '0')}`;
  };

  const ownerManualBookings = bookings.filter(booking => booking.source === 'owner_manual');
  const ownerManualIds = ownerManualBookings.map(booking => booking.id).filter(Boolean);
  const manualPaymentsByBooking = new Map();
  const manualRefundsByBooking = new Map();
  if (ownerManualIds.length) {
    const [paymentResult, refundResult] = await Promise.all([
      sb.from('owner_manual_payment_events')
        .select('id, booking_id, amount_cents, stripe_created_at, created_at')
        .in('booking_id', ownerManualIds),
      sb.from('owner_manual_refund_events')
        .select('booking_id, payment_event_id, amount_cents, stripe_created_at, created_at')
        .in('booking_id', ownerManualIds),
    ]);
    if (paymentResult.error || refundResult.error) {
      console.error('Tax report owner-manual ledger load error:', paymentResult.error || refundResult.error);
      return res.status(503).json({
        error: 'Owner-manual payment and refund tax dates could not be verified. Apply migrations through 047 and retry.',
        code: 'OWNER_MANUAL_TAX_LEDGER_UNAVAILABLE',
      });
    }
    for (const event of paymentResult.data || []) {
      if (!manualPaymentsByBooking.has(event.booking_id)) manualPaymentsByBooking.set(event.booking_id, []);
      manualPaymentsByBooking.get(event.booking_id).push(event);
    }
    for (const event of refundResult.data || []) {
      if (!manualRefundsByBooking.has(event.booking_id)) manualRefundsByBooking.set(event.booking_id, []);
      manualRefundsByBooking.get(event.booking_id).push(event);
    }
  }

  for (const b of bookings) {
    const tax = Math.max(0, Number(b.tax_amount || 0));
    const total = Math.max(0, Number(b.total_price || 0));
    if (b.source === 'owner_manual') {
      const paymentEvents = (manualPaymentsByBooking.get(b.id) || [])
        .slice()
        .sort((a, z) => String(a.stripe_created_at || a.created_at || '')
          .localeCompare(String(z.stripe_created_at || z.created_at || '')));
      let cumulativeGross = 0;
      let allocatedTax = 0;
      for (const event of paymentEvents) {
        const amount = Math.max(0, Number(event.amount_cents || 0));
        if (!amount) continue;
        cumulativeGross += amount;
        const targetAllocatedTax = total > 0
          ? Math.round(tax * Math.min(cumulativeGross, total) / total)
          : 0;
        const eventTax = Math.max(0, targetAllocatedTax - allocatedTax);
        allocatedTax = targetAllocatedTax;
        const key = periodKey(event.stripe_created_at || event.created_at);
        if (!key) continue;
        const row = bucket(key);
        row.taxCollectedCents += eventTax;
        row.taxableSalesCents += Math.max(0, amount - eventTax);
      }

      // Older cash/bank records predate the event ledger. Count them only when
      // the audited full-payment flag and collection timestamp both exist.
      if (!paymentEvents.length && b.payment_collected === true && b.payment_collected_at) {
        const charged = Math.max(0, Number(b.amount_charged ?? b.total_price ?? 0));
        const key = periodKey(b.payment_collected_at);
        if (key && charged > 0) {
          const collectedTax = total > 0 ? Math.round(tax * Math.min(charged, total) / total) : 0;
          const row = bucket(key);
          row.taxCollectedCents += collectedTax;
          row.taxableSalesCents += Math.max(0, charged - collectedTax);
        }
      }

      let cumulativeRefund = 0;
      let allocatedRefundTax = 0;
      const refundEvents = (manualRefundsByBooking.get(b.id) || [])
        .slice()
        .sort((a, z) => String(a.stripe_created_at || a.created_at || '')
          .localeCompare(String(z.stripe_created_at || z.created_at || '')));
      for (const event of refundEvents) {
        const amount = Math.max(0, Number(event.amount_cents || 0));
        if (!amount) continue;
        cumulativeRefund += amount;
        const targetRefundTax = total > 0
          ? Math.round(tax * Math.min(cumulativeRefund, total) / total)
          : 0;
        const eventRefundTax = Math.max(0, targetRefundTax - allocatedRefundTax);
        allocatedRefundTax = targetRefundTax;
        const key = periodKey(event.stripe_created_at || event.created_at);
        if (key) {
          const row = bucket(key);
          row.taxRefundedCents += eventRefundTax;
          row.taxableSalesRefundedCents += Math.max(0, amount - eventRefundTax);
        }
      }
      continue;
    }

    const taxEventAt = b.payment_captured_at;
    if (!taxEventAt) continue;

    const charged = Number(b.amount_charged || b.total_price || 0);
    const ck = periodKey(taxEventAt);
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
        const row = bucket(rk);
        row.taxRefundedCents += refundTax;
        row.taxableSalesRefundedCents += Math.max(0, Math.min(refundAmt, charged) - refundTax);
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
        bucket(r.filing_period);
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
    const netTaxableSalesCents = p.taxableSalesCents - p.taxableSalesRefundedCents;
    return {
      period: p.period,
      taxableSalesCents: netTaxableSalesCents,
      grossTaxableSalesCents: p.taxableSalesCents,
      taxableSalesRefundedCents: p.taxableSalesRefundedCents,
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
    grossTaxableSalesCents: t.grossTaxableSalesCents + p.grossTaxableSalesCents,
    taxableSalesRefundedCents: t.taxableSalesRefundedCents + p.taxableSalesRefundedCents,
    taxCollectedCents: t.taxCollectedCents + p.taxCollectedCents,
    taxRefundedCents: t.taxRefundedCents + p.taxRefundedCents,
    netLiabilityCents: t.netLiabilityCents + p.netLiabilityCents,
    remittedCents: t.remittedCents + p.remittedCents,
    outstandingCents: t.outstandingCents + p.outstandingCents,
  }), {
    taxableSalesCents: 0,
    grossTaxableSalesCents: 0,
    taxableSalesRefundedCents: 0,
    taxCollectedCents: 0,
    taxRefundedCents: 0,
    netLiabilityCents: 0,
    remittedCents: 0,
    outstandingCents: 0,
  });

  return res.status(200).json({
    granularity,
    rateLabel: '8.25% (TX state 6.25% + local 2.00%)',
    basis: 'Collected on payment-capture date; refunds reduce taxable sales and liability on the refund date. Pass-through liability owed to the Texas Comptroller — never platform revenue.',
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

  if (!/^\d{4}-(?:0[1-9]|1[0-2]|Q[1-4])$/.test(filingPeriod)) {
    return res.status(400).json({ error: 'Filing period must be YYYY-MM or YYYY-Q1 through YYYY-Q4.' });
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'A positive remittance amount is required.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRemitted)
      || Number.isNaN(new Date(`${dateRemitted}T12:00:00Z`).getTime())) {
    return res.status(400).json({ error: 'A valid remittance date is required.' });
  }
  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const todayCentral = `${todayParts.find(part => part.type === 'year')?.value}-${todayParts.find(part => part.type === 'month')?.value}-${todayParts.find(part => part.type === 'day')?.value}`;
  if (dateRemitted > todayCentral) {
    return res.status(400).json({ error: 'Remittance date cannot be in the future.' });
  }

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
