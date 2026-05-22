import { getSupabase } from '../_supabase.js';
import { createClient } from '@supabase/supabase-js';

/**
 * GET /api/booking/my-assignments
 * Returns bookings assigned to the authenticated assembler.
 * Requires Bearer JWT auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const sb = getSupabase();

  // Optional status filter via ?status=confirmed or ?status=completed
  // Default: return all assigned bookings (all statuses)
  const statusFilter = req.query?.status || null;

  // Active statuses: jobs the Easer needs to act on or track
  // Completed: last 30 days for earnings history
  // Excluded: cancelled, declined, refunded — Easer should not see these
  const ACTIVE_STATUSES   = ['confirmed', 'en_route', 'arrived', 'in_progress'];
  const VISIBLE_STATUSES  = [...ACTIVE_STATUSES, 'completed'];

  let query = sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_phone, customer_email, date, time, address, details, status, assigned_at, assembler_accepted_at, completed_at, checked_in_at, en_route_at, job_started_at, assembler_due, amount_charged, platform_fee, platform_fee_pct, payout_status, assignment_token, has_membership, total_price')
    .eq('assembler_id', user.id)
    .order('assigned_at', { ascending: false });

  if (statusFilter) {
    // Explicit filter requested — honour it but still exclude cancelled/declined
    if (VISIBLE_STATUSES.includes(statusFilter)) {
      query = query.eq('status', statusFilter);
    } else {
      query = query.in('status', VISIBLE_STATUSES);
    }
  } else {
    // Default: only statuses that make sense for an Easer to see
    query = query.in('status', VISIBLE_STATUSES);
  }

  const { data: bookings, error } = await query;

  if (error) {
    console.error('My assignments error:', error);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }

  // Enrich with open dispatch offer expiry time (for offer countdown timer)
  const pendingBookings = (bookings || []).filter(b => !b.assembler_accepted_at);
  if (pendingBookings.length > 0) {
    const { data: openOffers } = await sb
      .from('dispatch_offers')
      .select('booking_id, expires_at, token, dispatch_score')
      .in('booking_id', pendingBookings.map(b => b.id))
      .eq('easer_id', user.id)
      .eq('offer_status', 'sent')
      .gt('expires_at', new Date().toISOString());

    if (openOffers?.length) {
      const offerMap = {};
      openOffers.forEach(o => { offerMap[o.booking_id] = o; });
      (bookings || []).forEach(b => {
        if (offerMap[b.id]) {
          b._offer_expires_at = offerMap[b.id].expires_at;
          b._offer_token = offerMap[b.id].token;
          b._offer_score = offerMap[b.id].dispatch_score;
        }
      });
    }
  }

  // Add pay estimate — uses same formula as assembler-complete.js so the
  // displayed estimate matches the actual payout (removed the spurious 0.97 multiplier)
  (bookings || []).forEach(b => {
    const price = Number(b.amount_charged || b.total_price) || 0;
    if (price > 0) {
      const feePct     = b.has_membership ? 18 : 25;
      const payout     = Math.round(price * (1 - feePct / 100));
      b._pay_estimate_lo = payout; // exact match to actual payout formula
      b._pay_estimate_hi = payout;
      b._fee_pct         = feePct;
    }
  });

  return res.status(200).json({ bookings: bookings || [] });
}
