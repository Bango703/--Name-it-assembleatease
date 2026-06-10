import { getSupabase } from '../_supabase.js';
import { createClient } from '@supabase/supabase-js';
import {
  BOOKING_STATUS,
  DISPATCH_OFFER_STATUS,
  ACTIVE_BOOKING_STATUSES,
  VISIBLE_ASSIGNMENT_STATUSES,
  getPlatformFeePct,
} from '../_source-of-truth.js';

/**
 * GET /api/booking/my-assignments
 * Returns bookings assigned to the authenticated assembler PLUS any open
 * dispatch offers sent to this Easer that haven't been accepted yet.
 * Requires Bearer JWT auth.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const token = auth.replace('Bearer ', '');
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const sb = getSupabase();
  const warnings = [];

  function pushWarning(code, message) {
    warnings.push({ code, message });
  }

  const statusFilter = req.query?.status || null;
  const ACTIVE_STATUSES  = ACTIVE_BOOKING_STATUSES;
  const VISIBLE_STATUSES = VISIBLE_ASSIGNMENT_STATUSES;

  // Membership status from profile
  let easerProfile = null;
  try {
    const { data, error } = await sb
      .from('profiles')
      .select('has_membership')
      .eq('id', user.id)
      .single();
    if (error) throw error;
    easerProfile = data;
  } catch (profileError) {
    console.error('My assignments profile warning:', profileError);
    pushWarning('profile_lookup_partial_failure', 'Membership status could not be verified for this refresh.');
  }
  const easerIsMember = easerProfile?.has_membership === true;
  // Canonical fee — must match the completion payout (assembler-complete.js) so the
  // dashboard estimate never overstates what the Pro will actually receive.
  const feePct = getPlatformFeePct(easerIsMember);

  // ── 1. Bookings assigned to this Easer ──────────────────────────────────
  let query = sb
    .from('bookings')
    .select('id, ref, service, customer_name, customer_phone, customer_email, date, time, address, details, status, assigned_at, assembler_accepted_at, completed_at, checked_in_at, en_route_at, job_started_at, assembler_due, amount_charged, platform_fee, platform_fee_pct, payout_status, paid_out_at, payout_notes, assignment_token, total_price, evidence_requested_at')
    .eq('assembler_id', user.id)
    .order('assigned_at', { ascending: false });

  if (statusFilter) {
    query = VISIBLE_STATUSES.includes(statusFilter)
      ? query.eq('status', statusFilter)
      : query.in('status', VISIBLE_STATUSES);
  } else {
    query = query.in('status', VISIBLE_STATUSES);
  }

  const { data: assignedBookings, error } = await query;
  if (error) {
    console.error('My assignments error:', error);
    return res.status(500).json({ error: 'Failed to load assignments' });
  }

  // ── 2. Open dispatch offers not yet accepted — bookings not yet in the list ──
  // These are jobs dispatched to this Easer but assembler_id is still null
  // (or set to someone else). Without this, Easer can't see the job unless
  // they still have the email open.
  let openOffers = [];
  try {
    const { data, error } = await sb
      .from('dispatch_offers')
      .select('booking_id, expires_at, token, dispatch_score')
      .eq('easer_id', user.id)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
      .gt('expires_at', new Date().toISOString());
    if (error) throw error;
    openOffers = data || [];
  } catch (offerError) {
    console.error('My assignments open-offers warning:', offerError);
    pushWarning('open_offers_partial_failure', 'Some dispatch offers could not be loaded right now.');
  }

  const assignedIds = new Set((assignedBookings || []).map(b => b.id));
  const unacceptedOfferBookingIds = (openOffers || [])
    .map(o => o.booking_id)
    .filter(id => !assignedIds.has(id));

  let offerBookings = [];
  if (unacceptedOfferBookingIds.length > 0) {
    try {
      const { data, error } = await sb
        .from('bookings')
        .select('id, ref, service, customer_name, date, time, address, details, status, total_price')
        .in('id', unacceptedOfferBookingIds)
        .eq('status', BOOKING_STATUS.CONFIRMED)
        .is('assembler_id', null);
      if (error) throw error;
      offerBookings = data || [];
    } catch (bookingError) {
      console.error('My assignments offer-booking warning:', bookingError);
      pushWarning('offer_bookings_partial_failure', 'Some pending offers could not be expanded into bookings.');
    }
  }

  // Build offer map for enrichment
  const offerMap = {};
  (openOffers || []).forEach(o => { offerMap[o.booking_id] = o; });

  // Enrich offer-only bookings — mark as pending offer, hide customer PII until accepted
  offerBookings.forEach(b => {
    b._is_pending_offer = true;
    b.customer_name  = null;  // hide until accepted
    b.customer_phone = null;
    b.customer_email = null;
    if (offerMap[b.id]) {
      b._offer_expires_at = offerMap[b.id].expires_at;
      b._offer_token      = offerMap[b.id].token;
      b._offer_score      = offerMap[b.id].dispatch_score;
    }
  });

  // Enrich already-assigned bookings that haven't been accepted yet (legacy path)
  (assignedBookings || []).forEach(b => {
    if (!b.assembler_accepted_at && offerMap[b.id]) {
      b._offer_expires_at = offerMap[b.id].expires_at;
      b._offer_token      = offerMap[b.id].token;
      b._offer_score      = offerMap[b.id].dispatch_score;
    }
  });

  // For completed jobs where evidence was requested, flag whether evidence has been uploaded.
  // This lets the Easer dashboard show/hide the upload prompt without a separate API call.
  const evidenceRequestedIds = (assignedBookings || [])
    .filter(b => b.evidence_requested_at)
    .map(b => b.id);

  if (evidenceRequestedIds.length) {
    try {
      const { data: evidenceRows } = await sb
        .from('booking_evidence')
        .select('booking_id')
        .in('booking_id', evidenceRequestedIds);
      const uploadedSet = new Set((evidenceRows || []).map(r => r.booking_id));
      (assignedBookings || []).forEach(b => {
        if (b.evidence_requested_at) b._evidence_uploaded = uploadedSet.has(b.id);
      });
    } catch (evErr) {
      console.warn('my-assignments evidence check skipped:', evErr?.message || evErr);
    }
  }

  // ── 3. Merge and add pay estimates ──────────────────────────────────────
  const allBookings = [...offerBookings, ...(assignedBookings || [])];

  allBookings.forEach(b => {
    if (b.status === 'completed') return;
    const price = Number(b.amount_charged || b.total_price) || 0;
    if (price > 0) {
      const payout       = Math.round(price * (1 - feePct / 100));
      b._pay_estimate_lo = payout;
      b._pay_estimate_hi = payout;
      b._fee_pct         = feePct;
    } else if (b.total_price === 0 || b.total_price === null) {
      b._custom_quote = true; // signal to UI: price TBD
    }
  });

  const response = { bookings: allBookings };
  if (warnings.length > 0) {
    response.meta = {
      partial: true,
      warnings,
    };
  }

  return res.status(200).json(response);
}
