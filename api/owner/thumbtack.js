import { verifyOwner } from '../_email.js';
import { getSupabase } from '../_supabase.js';
import { loadLedgerFirstFinanceRows } from './_finance-ledger.js';

const MAX_CENTS = 100000000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();
  if (req.method === 'GET') return loadView(sb, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const negotiationId = String(body.negotiationId || '').trim();
  if (!negotiationId || negotiationId.length > 120) return res.status(400).json({ error: 'Invalid lead ID' });
  const update = { updated_by: 'owner', updated_at: new Date().toISOString() };
  if (Object.prototype.hasOwnProperty.call(body, 'leadPriceCents')) {
    const n = Number(body.leadPriceCents);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CENTS) return res.status(400).json({ error: 'Lead cost must be a valid amount in cents.' });
    update.lead_price_cents = n;
    update.lead_price_source = 'owner_recorded';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'refundedCents')) {
    const n = Number(body.refundedCents);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CENTS) return res.status(400).json({ error: 'Refund or credit must be a valid amount in cents.' });
    update.refunded_cents = n;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'creditedCents')) {
    const n = Number(body.creditedCents);
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CENTS) return res.status(400).json({ error: 'Courtesy credit must be a valid amount in cents.' });
    update.credited_cents = n;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bookingId')) {
    const bookingId = body.bookingId == null || body.bookingId === '' ? null : String(body.bookingId);
    if (bookingId) {
      const { data: booking, error } = await sb.from('bookings').select('id,external_platform,is_test_booking').eq('id', bookingId).maybeSingle();
      if (error) return res.status(503).json({ error: 'Could not verify the selected booking.' });
      if (!booking || booking.external_platform !== 'thumbtack' || booking.is_test_booking === true) return res.status(400).json({ error: 'Select a real booking recorded as originating from Thumbtack.' });
      update.booking_id = bookingId;
      update.owner_outcome = 'booked';
    } else update.booking_id = null;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'ownerOutcome')) {
    const outcome = String(body.ownerOutcome || '');
    if (!['open','booked','not_converted'].includes(outcome)) return res.status(400).json({ error: 'Choose a valid Thumbtack lead outcome.' });
    if (outcome === 'booked' && !update.booking_id) return res.status(400).json({ error: 'Link the AAE booking before marking this lead booked.' });
    if (outcome !== 'booked' && update.booking_id) return res.status(400).json({ error: 'Clear the linked AAE booking before changing the outcome.' });
    update.owner_outcome = outcome;
  }
  if (Object.keys(update).length <= 2) return res.status(400).json({ error: 'No supported update was supplied.' });
  const { data, error } = await sb.from('thumbtack_leads').update(update).eq('negotiation_id', negotiationId).select('negotiation_id').maybeSingle();
  if (error?.code === '23505') return res.status(409).json({ error: 'That AAE booking is already linked to another Thumbtack lead.' });
  if (error) return res.status(503).json({ error: 'Could not update Thumbtack lead.' });
  if (!data) return res.status(404).json({ error: 'Thumbtack lead not found.' });
  return loadView(sb, res);
}

async function loadView(sb, res) {
  const { data: leads, error } = await sb.from('thumbtack_leads').select('*').order('lead_created_at', { ascending: false, nullsFirst: false }).limit(500);
  if (error) return res.status(503).json({ error: 'Thumbtack records are unavailable.' });
  const [bookingResult, financeResult] = await Promise.allSettled([
    sb.from('bookings').select('id,ref,status,external_platform,service,date,created_at,total_price,amount_charged,is_test_booking').eq('external_platform', 'thumbtack').order('created_at', { ascending: false }).limit(300),
    loadLedgerFirstFinanceRows(sb),
  ]);
  const bookings = bookingResult.status === 'fulfilled' && !bookingResult.value.error ? (bookingResult.value.data || []).filter(b => b.is_test_booking !== true) : [];
  const finance = financeResult.status === 'fulfilled' && !financeResult.value?.error ? financeResult.value : null;
  const financeRows = new Map((finance?.rows || []).map(row => [row.bookingId, row]));
  let cost = 0, refunds = 0, credits = 0, linkedJobs = 0, completed = 0, recordedPayments = 0, platformGross = 0, returnKnown = true;
  const decorated = (leads || []).map(lead => {
    const f = lead.booking_id ? financeRows.get(lead.booking_id) : null;
    const job = bookings.find(row => row.id === lead.booking_id) || null;
    const charged = Number.isSafeInteger(lead.lead_price_cents) ? lead.lead_price_cents : null;
    cost += charged ?? 0;
    if (Number.isSafeInteger(lead.refunded_cents)) refunds += lead.refunded_cents;
    if (Number.isSafeInteger(lead.credited_cents)) credits += lead.credited_cents;
    if (job && lead.owner_outcome === 'booked') {
      linkedJobs++;
      if (job.status === 'completed') {
        if (f && Number.isSafeInteger(f.netCharged) && Number.isSafeInteger(f.platformRevenue)) {
          completed++; recordedPayments += f.netCharged; platformGross += f.platformRevenue;
        } else returnKnown = false;
      }
    }
    return { ...lead, booking: job ? { id: job.id, ref: job.ref || job.id.slice(0,8), status: job.status, service: job.service, date: job.date } : null,
      recordedPaymentsCents: job?.status === 'completed' && f && Number.isSafeInteger(f.netCharged) ? f.netCharged : null,
      platformGrossCents: job?.status === 'completed' && f && Number.isSafeInteger(f.platformRevenue) ? f.platformRevenue : null };
  });
  const allCostsKnown = decorated.every(l => Number.isSafeInteger(l.lead_price_cents));
  const allRefundsVerified = decorated.every(l => Number.isSafeInteger(l.refunded_cents) && Number.isSafeInteger(l.credited_cents));
  const allLeadsResolved = decorated.every(l => l.owner_outcome === 'not_converted' || (l.owner_outcome === 'booked' && Boolean(l.booking_id)));
  const allReturnsKnown = returnKnown && allLeadsResolved && decorated.every(l => l.owner_outcome === 'not_converted' ? !l.booking_id : l.booking?.status === 'completed');
  return res.status(200).json({ leads: decorated, bookings: bookings.map(b => ({ id: b.id, ref: b.ref || b.id.slice(0,8), status: b.status, service: b.service, date: b.date })),
    summary: { leads: decorated.length, knownLeadCosts: decorated.filter(l => Number.isSafeInteger(l.lead_price_cents)).length,
      leadCostCents: allCostsKnown ? cost : null, refundsCents: allRefundsVerified ? refunds : null, creditsCents: allRefundsVerified ? credits : null, netLeadCostCents: allCostsKnown && allRefundsVerified ? Math.max(0, cost - refunds - credits) : null, linkedJobs, completedJobs: completed,
      recordedPaymentsCents: allReturnsKnown ? recordedPayments : null, platformGrossCents: allReturnsKnown ? platformGross : null,
      netAfterLeadCostCents: allReturnsKnown && allCostsKnown && allRefundsVerified ? platformGross - Math.max(0, cost - refunds - credits) : null },
    warnings: [finance ? null : 'Financial return is unavailable until the financial ledger loads.', decorated.some(l => !Number.isSafeInteger(l.lead_price_cents)) ? 'Lead cost and net cost are unknown until every lead has a recorded charge.' : null,
      returnKnown ? null : 'At least one completed linked job has incomplete finance records; return totals are unknown.',
      allLeadsResolved ? null : 'Mark each lead as booked and link its AAE job, or mark it not converted, before using total return or net figures.',
      allRefundsVerified ? null : 'Verify each lead in Thumbtack and record the refund and courtesy credit, including $0 when none, before using net lead cost.'].filter(Boolean) });
}
