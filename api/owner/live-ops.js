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
  const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [bookingsRes, easersRes, activeOffersRes, runtimeErrorsRes, failedNotificationsRes, cronErrorsRes, damageReportsRes] = await Promise.all([
    sb.from('bookings')
      .select('id, ref, service, status, pipeline_stage, customer_name, customer_phone, date, time, address, assembler_id, assembler_name, assembler_tier, assigned_at, assembler_accepted_at, checked_in_at, en_route_at, job_started_at, completed_at, created_at, dispatch_offered_at, dispatch_status, needs_manual_dispatch, total_price')
      .not('status', 'in', '("cancelled","declined","completed")')
      .order('date', { ascending: true }),
    sb.from('profiles')
      .select('id, full_name, email, tier, rating, completed_jobs, is_available, has_membership, city, phone')
      .eq('role', 'assembler')
      .eq('status', 'active')
      .eq('identity_verified', true)
      .in('tier', ['starter', 'professional', 'elite']),
    sb.from('dispatch_offers')
      .select('id, booking_id, easer_id, notification_sent, expires_at')
      .eq('offer_status', 'sent')
      .gt('expires_at', now.toISOString()),
    sb.from('operational_events')
      .select('id, route, reason_detail, stage, created_at')
      .eq('event_type', 'runtime_error')
      .gte('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(8),
    sb.from('notification_log')
      .select('id, booking_id, channel, notification_type, recipient_type, recipient_email, recipient_user_id, subject, error_text, sent_at')
      .eq('status', 'failed')
      .gte('sent_at', twentyFourHoursAgo)
      .order('sent_at', { ascending: false })
      .limit(8),
    sb.from('cron_log')
      .select('id, cron_name, status, error_text, ran_at')
      .neq('status', 'ok')
      .gte('ran_at', twentyFourHoursAgo)
      .order('ran_at', { ascending: false })
      .limit(8),
    sb.from('activity_logs')
      .select('id, booking_id, description, metadata, created_at')
      .eq('event_type', 'damage_claim_reported')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const bookings = bookingsRes.data || [];
  const easers = easersRes.data || [];
  const now_ts = now.getTime();
  const activeOffers = activeOffersRes.data || [];
  const activeOfferBookingIds = new Set(activeOffers.map(o => o.booking_id));
  const runtimeErrors = (runtimeErrorsRes.data || []).map(row => ({
    kind: 'runtime',
    title: 'Customer-side page error',
    detail: row.reason_detail || 'Unknown browser error',
    meta: [row.route, row.stage].filter(Boolean).join(' • '),
    when: row.created_at,
    severity: 'high',
  }));
  const failedNotifications = (failedNotificationsRes.data || []).map(row => ({
    kind: 'notification',
    title: (row.channel || 'notification') + ' failed',
    detail: row.error_text || row.subject || 'Notification delivery failed',
    meta: [row.notification_type, row.recipient_type].filter(Boolean).join(' • '),
    when: row.sent_at,
    severity: 'medium',
    bookingId: row.booking_id || null,
    notificationId: row.id,
    recipient: row.recipient_email || row.recipient_user_id || row.recipient_type || 'unknown',
    recipientType: row.recipient_type || null,
    notificationType: row.notification_type || null,
    ownerAction: 'Review the booking timeline and contact the recipient using the booking record. Do not assume delivery.',
  }));
  const cronErrors = (cronErrorsRes.data || []).map(row => ({
    kind: 'cron',
    title: (row.cron_name || 'cron') + ' ' + (row.status || 'error'),
    detail: row.error_text || 'Cron run failed',
    meta: 'Background job',
    when: row.ran_at,
    severity: row.status === 'error' ? 'high' : 'medium',
  }));
  const damageReports = (damageReportsRes.data || []).map(row => ({
    id: row.id,
    bookingId: row.booking_id,
    detail: row.description || 'Easer reported possible damage',
    notes: row.metadata?.notes || null,
    when: row.created_at,
  }));

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

  const enRoute = bookings.filter(b => b.status === 'en_route');

  // A booking is "arrived" when status = 'arrived' OR it has checked_in_at but no job_started_at
  // (easer-status.js sets status='arrived' when Easer checks in)
  const arrived = bookings.filter(b => b.status === 'arrived');

  const inProgress = bookings.filter(b => b.status === 'in_progress');

  const pendingConfirm = bookings.filter(b => b.status === 'pending');

  // ── Alerts ──────────────────────────────────────────────────────
  const alerts = [];

  const workflowMismatches = bookings.filter(booking => {
    if (booking.pipeline_stage && booking.pipeline_stage !== booking.status) return true;
    if (booking.status === 'en_route') return !booking.assembler_accepted_at || !booking.en_route_at;
    if (booking.status === 'arrived') return !booking.assembler_accepted_at || !booking.en_route_at || !booking.checked_in_at;
    if (booking.status === 'in_progress') return !booking.assembler_accepted_at || !booking.en_route_at || !booking.checked_in_at || !booking.job_started_at;
    return booking.status === 'confirmed' && Boolean(booking.en_route_at || booking.checked_in_at || booking.job_started_at);
  });
  workflowMismatches.forEach(booking => alerts.push({
    type: 'workflow_state_mismatch',
    severity: 'high',
    ref: booking.ref,
    bookingId: booking.id,
    message: `${booking.ref} has conflicting status or workflow timestamps. Review before dispatch, completion, or payout.`,
    action: 'review_timeline',
  }));

  damageReports.forEach(report => {
    alerts.push({
      type: 'damage_claim_reported',
      severity: 'critical',
      ref: '',
      bookingId: report.bookingId,
      message: report.detail,
      detail: report.notes,
      action: 'review_damage_evidence',
    });
  });

  // Active offers with no channel-confirmed notification remain visible in the
  // Easer app, but need owner follow-up before the appointment is at risk.
  activeOffers.filter(offer => offer.notification_sent !== true).forEach(offer => {
    const booking = bookings.find(row => row.id === offer.booking_id);
    const easer = easers.find(row => row.id === offer.easer_id);
    alerts.push({
      type: 'dispatch_notification_failed',
      severity: 'high',
      ref: booking?.ref || '',
      bookingId: offer.booking_id,
      offerId: offer.id,
      recipientUserId: offer.easer_id,
      recipientEmail: easer?.email || null,
      message: `${booking?.service || 'Job offer'} — no notification channel confirmed delivery to ${easer?.full_name || 'the selected Easer'}`,
      action: 'contact_easer',
    });
  });

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
  runtimeErrors.slice(0, 3).forEach(err => alerts.push({
    type: 'runtime_error',
    severity: err.severity,
    ref: '',
    bookingId: '',
    message: err.detail,
    action: null,
  }));

  const assignedIds = new Set(bookings.filter(b => b.assembler_id).map(b => b.assembler_id));
  // Map assembler_id → their active booking's pipeline stage (en_route, arrived, in_progress, confirmed)
  const assemblerStageMap = {};
  bookings.filter(b => b.assembler_id).forEach(b => {
    assemblerStageMap[b.assembler_id] = b.pipeline_stage || b.status;
  });
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
      criticalAlerts: alerts.filter(a => a.severity === 'critical' || a.severity === 'high').length,
      runtimeErrors: runtimeErrors.length,
      failedNotifications: failedNotifications.length,
      unnotifiedActiveOffers: activeOffers.filter(offer => offer.notification_sent !== true).length,
      recentDamageReports: damageReports.length,
      workflowMismatches: workflowMismatches.length,
      cronErrors: cronErrors.length,
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
      booking_stage: assemblerStageMap[e.id] || null,
    })),
    offlineCount: offlineEasers.length,
    recentFailures: runtimeErrors.concat(failedNotifications, cronErrors)
      .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
      .slice(0, 12),
    damageReports,
  });
}
