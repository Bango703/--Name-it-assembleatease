import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { loadContractorTaxYear, defaultTaxYear, stripeAdjustmentCsv } from './_contractor-tax.js';

/**
 * GET /api/owner/stripe-1099-adjustments?year=2026
 *
 * The CSV to import in Stripe (Connect > Tax reporting > Import > 1099-NEC >
 * Delta) so each Easer's Stripe-filed 1099 leaves out the reimbursements that
 * were paid inside their transfers. Owner only. The amounts come from the same
 * totals the dashboard shows (api/owner/_contractor-tax.js).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const requested = Number.parseInt(String(req.query?.year || ''), 10);
  const year = Number.isInteger(requested) && requested >= 2025 && requested <= 2100 ? requested : defaultTaxYear();
  const tax = await loadContractorTaxYear(getSupabase(), year);
  if (!tax.available) return res.status(503).json({ error: 'Payout records could not be loaded, so no file was made. Try again.' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="stripe-1099-nec-reimbursement-deltas-${year}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(stripeAdjustmentCsv(tax.easers));
}
