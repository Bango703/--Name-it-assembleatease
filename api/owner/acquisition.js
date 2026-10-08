import { verifyOwner } from '../_email.js';
import { getSupabase } from '../_supabase.js';
import { loadBookingDemand } from './market-demand.js';
import { loadLedgerFirstFinanceRows } from './_finance-ledger.js';
import { buildAcquisitionReport } from './_acquisition-report.js';

export function createAcquisitionHandler(dependencies = {}) {
  const authorized = dependencies.verifyOwner || verifyOwner;
  const database = dependencies.getSupabase || getSupabase;
  const bookingLoader = dependencies.loadBookingDemand || loadBookingDemand;
  const financeLoader = dependencies.loadFinance || loadLedgerFirstFinanceRows;
  const now = dependencies.now || (() => new Date());
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const period = String(req.query?.period || '90');
    if (!['28', '90', 'all'].includes(period)) return res.status(400).json({ error: 'Choose 28, 90 or all.' });
    try {
      const sb = database();
      const [bookings, finance] = await Promise.allSettled([Promise.resolve().then(() => bookingLoader(sb)), Promise.resolve().then(() => financeLoader(sb))]);
      if (bookings.status !== 'fulfilled' || bookings.value?.error || !Array.isArray(bookings.value?.data)) return res.status(503).json({ error: 'Booking source unavailable. Counts cannot be verified.' });
      const data = bookings.value;
      const report = buildAcquisitionReport(data.data, finance.status === 'fulfilled' ? finance.value : null, { period, now: now(), totalCount: data.totalCount });
      if (data.attributionColumnMissing) report.warnings.push('Historical attribution column unavailable; channel evidence may be incomplete.');
      if (data.locationColumnsMissing) report.warnings.push('Structured service location columns unavailable; city labels use recorded address evidence where possible.');
      return res.status(200).json(report);
    } catch {
      return res.status(503).json({ error: 'Acquisition report unavailable. Retry without interpreting missing data as zero.' });
    }
  };
}

export default createAcquisitionHandler();
