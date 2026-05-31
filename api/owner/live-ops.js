import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

/**
 * GET /api/owner/live-ops
 * Real-time operational snapshot for the Live Ops command center.
 */
export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });

  const sb = getSupabase();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
  const thirtyMinAgo = new Date(now - 30 * 60 * 1000).toISOString();

  const [bookingsRes, easersRes, activeOffersRes] = await Promise.all([
    sb.from('bookings')
      .select('id, ref, service, status, pipeline_stage, customer_name, customer_phone, date, time, address, assembler_id, assembler_name, assembler_tier, assigned_at, assembler_accepted_at, checked_in_at, en_route_at, job_started_at, completed_at, created_at, dispatch_offered_at, dispatch_status, needs_manual_dispatch, total_price')
      .not('status', 'in', '("cancelled","declined","completed")')
      .order('date', { ascending: true }),
    sb.from('profiles')
      .select('id, full_name, tier, rating, completed_jobs, is_available, has_membership, city, phone')
      .eq('role', 'assembler')
      .eq('identity_verified', true)
      .in('tier', ['starter', 'professional', 'elite']),
    sb.from('dispatch_offers')
      .select('booking_id')
      .eq('offer_status', 'sent')
      .gt('expires_at', now.toISOString()),
  ]);

  const bookings = bookingsRes.data || [];
  const easers = easersRes.data || [];
  const now_ts = now.getTime();
  const activeOfferBookingIds = new Set((activeOffersRes.data || []).map(o => o.booking_id));

  // ── Categorize bookings ─────────────────────────────────────────
  // unassigned: never dispatched, no active offers, not flagged manual
  const unassigned = bookings.filter(b =>
    b.status === 'confirmed' && !b.assembler_id &&
    !activeOfferBookingIds.has(b.id) && !b.dispatch_offered_at && !b.needs_manual_dispatch
  );

  // awaitingDispatch: has live unexpired offers outstanding right now
  const awaitingDispatch = bookings
    .filter(b =>
      b.status === 'confirmed' && !b.assembler_id &&
      activeOfferBookingIds.has(b.id) && !b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'active_offers' }));

  // offersExpired: was dispatched but all offers expired/declined, not yet flagged manual
  const offersExpired = bookings
    .filter(b =>
      b.status === 'confirmed' && !b.assembler_id &&
      !activeOfferBookingIds.has(b.id) && b.dispatch_offered_at && !b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'offers_expired' }));

  // needsManual: max attempts reached or explicitly flagged for manual assignment
  const needsManual = bookings
    .filter(b =>
      b.status === 'confirmed' && !b.assembler_id && b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'needs_manual' }));

  const awaitingAcceptance = bookings.filter(b =>
    b.assembler_id && !b.assembler_accepted_at && b.status === 'confirmed'
  );

  const enRoute = bookings.filter(b =>
    b.status === 'en_route' || b.pipeline_stage === 'en_route'
  );

  // A booking is "arrived" when status = 'arrived' OR it has checked_in_at but no job_started_at
  // (easer-status.js sets status='arrived' when Easer checks in)
  const arrived = bookings.filter(b =>
    b.status === 'arrived' || (b.checked_in_at && !b.job_started_at && b.status !== 'in_progress')
  );

  const inProgress = bookings.filter(b =>
    b.status === 'in_progress' || b.pipeline_stage === 'in_progress' ||
    (b.job_started_at && b.status === 'confirmed')
  );

  const pendingConfirm = bookings.filter(b => b.status === 'pending');

  // ── Alerts ──────────────────────────────────────────────────────
  const alerts = [];

  // Stale unassigned (>2 hours old)
  bookings.filter(b => !b.assembler_id && b.status === 'confirmed').forEach(b => {
    const age = (now_ts - new Date(b.created_at).getTime()) / 3600000;
    if (age > 2) alerts.push({
      type: 'unassigned_stale',
      severity: 'high',
      ref: b.ref,
      bookingId: b.id,
      message: `${b.service} — no Easer assigned for ${Math.round(age)}h`,
      action: 'dispatch',
    });
  });

  // All offers expired without acceptance — needs re-dispatch
  offersExpired.forEach(b => {
    const age = (now_ts - new Date(b.dispatch_offered_at).getTime()) / 3600000;
    alerts.push({
      type: 'dispatch_no_response',
      severity: 'medium',
      ref: b.ref,
      bookingId: b.id,
      message: `${b.service} — all offers expired ${Math.round(age)}h ago, no acceptance`,
      action: 'redispatch',
    });
  });

  // Needs manual dispatch — max attempts reached or explicitly flagged
  needsManual.forEach(b => {
    alerts.push({
      type: 'needs_manual_dispatch',
      severity: 'high',
      ref: b.ref,
      bookingId: b.id,
      message: `${b.service} — max attempts reached, manual assignment needed`,
      action: 'dispatch',
    });
  });

  // Assigned but not accepted >30min
  awaitingAcceptance.forEach(b => {
    if (!b.assigned_at) return;
    const age = (now_ts - new Date(b.assigned_at).getTime()) / 60000;
    if (age > 30) alerts.push({
      type: 'no_acceptance',
      severity: 'medium',
      ref: b.ref,
      bookingId: b.id,
      message: `${b.assembler_name || 'Easer'} hasn't accepted ${b.ref} — ${Math.round(age)}min since assigned`,
      action: 'reassign',
    });
  });

  // Today's jobs not yet assigned
  const todayUnassigned = bookings.filter(b =>
    b.date === todayStr && !b.assembler_id && b.status === 'confirmed'
  );
  todayUnassigned.forEach(b => alerts.push({
    type: 'today_unassigned',
    severity: 'critical',
    ref: b.ref,
    bookingId: b.id,
    message: `TODAY: ${b.service} at ${b.time || 'TBD'} — no Easer assigned`,
    action: 'dispatch',
  }));

  // Pending payments older than 1hr
  pendingConfirm.filter(b => {
    const age = (now_ts - new Date(b.created_at).getTime()) / 3600000;
    return age > 1;
  }).forEach(b => alerts.push({
    type: 'stale_pending',
    severity: 'low',
    ref: b.ref,
    bookingId: b.id,
    message: `${b.ref} — pending payment for ${Math.round((now_ts - new Date(b.created_at).getTime()) / 3600000)}h`,
    action: null,
  }));

  // ── Easer availability ──────────────────────────────────────────
  const assignedIds = new Set(bookings.filter(b => b.assembler_id).map(b => b.assembler_id));
  const onlineEasers = easers.filter(e => e.is_available);
  const offlineEasers = easers.filter(e => !e.is_available);
  const busyEasers = onlineEasers.filter(e => assignedIds.has(e.id));
  const freeEasers = onlineEasers.filter(e => !assignedIds.has(e.id));

  // ── Today's schedule ─────────────────────────────────────────────
  const todayAll = bookings.filter(b => b.date === todayStr);

  return res.status(200).json({
    generatedAt: now.toISOString(),
    summary: {
      // Exclude 'pending' (awaiting payment) from Active Jobs count so the
      // chip matches what's actually shown in the Active Jobs panel.
      totalActive: bookings.filter(b => b.status !== 'pending').length,
      pendingPayment: pendingConfirm.length,
      unassigned: unassigned.length,
      awaitingDispatch: awaitingDispatch.length,
      offersExpired: offersExpired.length,
      needsManual: needsManual.length,
      awaitingAcceptance: awaitingAcceptance.length,
      enRoute: enRoute.length,
      arrived: arrived.length,
      inProgress: inProgress.length,
      alertCount: alerts.length,
      criticalAlerts: alerts.filter(a => a.severity === 'critical').length,
      onlineEasers: onlineEasers.length,
      freeEasers: freeEasers.length,
      todayJobs: todayAll.length,
    },
    alerts: alerts.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return order[a.severity] - order[b.severity];
    }),
    unassigned,
    awaitingDispatch,
    offersExpired,
    needsManual,
    awaitingAcceptance,
    enRoute,
    arrived,
    inProgress,
    pendingConfirm,
    todaySchedule: todayAll,
    onlineEasers: onlineEasers.map(e => ({
      ...e,
      status: assignedIds.has(e.id) ? 'working' : 'available',
    })),
    offlineCount: offlineEasers.length,
  });
}
