// GET /api/owner/dispatch-health?market=houston
// Owner-only. Assignment time, offer acceptance, unassigned bookings,
// cancellations, completed jobs and recruitment triggers for one market.
// Reads only. The numbers are computed in ./_dispatch-health.js.
import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { SERVICE_MARKETS } from '../_source-of-truth.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import { EASER_READINESS_FIELDS } from '../_easer-readiness-select.js';
import { buildDispatchHealth, marketPrefixes } from './_dispatch-health.js';

export const DISPATCH_HEALTH_BOOKING_SELECT = [
  'id', 'ref', 'service', 'service_city', 'service_zip', 'status', 'date', 'time',
  'created_at', 'confirmed_at', 'assigned_at', 'assembler_accepted_at', 'assembler_id',
  'needs_manual_dispatch', 'dispatch_paused', 'cancel_reason', 'decline_reason',
  'completed_at', 'is_test_booking',
].join(', ');

export const DISPATCH_HEALTH_EASER_SELECT = ['id', 'zip', 'role', ...EASER_READINESS_FIELDS].join(', ');

function zipFilter(prefixes) {
  return prefixes.map(p => `service_zip.like.${p}%`).join(',');
}

export function createDispatchHealthHandler(dependencies = {}) {
  const supabase = dependencies.getSupabase || getSupabase;
  const ownerAuthorized = dependencies.verifyOwner || verifyOwner;
  const readinessFor = dependencies.getEaserReadiness || getEaserReadiness;
  const now = dependencies.now || (() => Date.now());

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!ownerAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const market = String((req.query && req.query.market) || 'houston').trim().toLowerCase();
    if (!SERVICE_MARKETS[market]) return res.status(400).json({ error: `Unknown market "${market}".` });
    const prefixes = marketPrefixes(market);
    const sb = supabase();

    const { data: bookings, error: bookingError } = await sb
      .from('bookings')
      .select(DISPATCH_HEALTH_BOOKING_SELECT)
      .or(zipFilter(prefixes))
      .order('created_at', { ascending: false })
      .limit(2000);
    if (bookingError) {
      console.error('dispatch health booking load failed:', bookingError.message || bookingError);
      return res.status(500).json({ error: 'Bookings could not be loaded, so dispatch health is unknown.' });
    }

    const ids = (bookings || []).map(b => b.id);
    let offers = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb
        .from('dispatch_offers')
        .select('booking_id, offer_status, attempt_number')
        .in('booking_id', ids.slice(i, i + 200));
      if (error) {
        console.error('dispatch health offer load failed:', error.message || error);
        return res.status(500).json({ error: 'Dispatch offers could not be loaded, so acceptance is unknown.' });
      }
      offers = offers.concat(data || []);
    }

    const { data: profiles, error: easerError } = await sb
      .from('profiles')
      .select(DISPATCH_HEALTH_EASER_SELECT)
      .eq('role', 'assembler')
      .or(prefixes.map(p => `zip.like.${p}%`).join(','));
    if (easerError) {
      console.error('dispatch health Easer load failed:', easerError.message || easerError);
      return res.status(500).json({ error: 'Easers could not be loaded, so supply is unknown.' });
    }
    const easers = [];
    for (const profile of profiles || []) {
      let isReady = false;
      try {
        const readiness = await readinessFor(profile, { requireAvailability: false, stripeAccount: null });
        isReady = readiness?.isReady === true;
      } catch (error) {
        console.error('dispatch health readiness failed:', error?.message || error);
      }
      easers.push({ id: profile.id, isReady });
    }

    return res.status(200).json(buildDispatchHealth({ bookings: bookings || [], offers, easers, market, now: now() }));
  };
}

export default createDispatchHealthHandler();
