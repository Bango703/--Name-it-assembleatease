import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';
import { getEaserReadiness } from '../_easer-readiness.js';
import { DISPATCH_PAYMENT_STATUSES, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';

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

  const bookingProjection = 'id, ref, service, status, payment_status, pipeline_stage, customer_name, customer_email, customer_phone, date, time, address, assembler_id, assembler_name, assembler_tier, assigned_at, assembler_accepted_at, checked_in_at, en_route_at, job_started_at, completed_at, created_at, dispatch_offered_at, dispatch_status, dispatch_paused, needs_manual_dispatch, total_price, deposit_amount, stripe_payment_intent_id, stripe_deposit_intent_id, stripe_balance_payment_intent_id, confirmed_by, quote_amount_cents, quote_sent_at, quote_expires_at, quote_approval_started_at, financial_operation_key, financial_operation_type, financial_operation_started_at, cancellation_reconciliation_required_at, cancellation_reconciliation_reason, financial_reconciliation_required_at, financial_reconciliation_reason, stripe_dispute_hold, stripe_dispute_id, stripe_dispute_status, stripe_dispute_amount_cents, stripe_dispute_reason, stripe_dispute_opened_at, stripe_dispute_updated_at';
  const [bookingsRes, financialHoldsRes, easersRes, activeOffersRes, runtimeErrorsRes, failedNotificationsRes, cronErrorsRes, damageReportsRes] = await Promise.all([
    sb.from('bookings')
      .select(bookingProjection)
      .not('status', 'in', '("cancelled","declined","completed")')
      .order('date', { ascending: true }),
    sb.from('bookings')
      .select(bookingProjection)
      .not('financial_reconciliation_required_at', 'is', null)
      .order('financial_reconciliation_required_at', { ascending: true })
      .limit(50),
    sb.from('profiles')
      .select('id, full_name, email, tier, rating, completed_jobs, is_available, has_membership, city, phone, status, application_status, identity_verified, contractor_agreement_signed_at, contractor_agreement_version, code_of_conduct_agreed_at, application_fee_paid, application_fee_waived, fee_waived_by_owner, application_fee_refunded, application_fee_refunded_cents, application_fee_refund_pending_cents, application_fee_refund_review_required_at, application_fee_refund_review_reason, account_closure_status, stripe_connect_account_id')
      .eq('role', 'assembler'),
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

  const essentialErrors = [
    ['bookings', bookingsRes.error],
    ['financial reconciliation holds', financialHoldsRes.error],
    ['Easer readiness', easersRes.error],
    ['active dispatch offers', activeOffersRes.error],
  ].filter(([, error]) => error);
  if (essentialErrors.length) {
    console.error('[live-ops] Essential data unavailable:', essentialErrors.map(([source, error]) => `${source}: ${error.message || error}`).join('; '));
    return res.status(503).json({
      error: 'Live Ops cannot verify essential booking and dispatch state. Keep the prior dashboard state and retry.',
      code: 'LIVE_OPS_ESSENTIAL_DATA_UNAVAILABLE',
      unavailable: essentialErrors.map(([source]) => source),
    });
  }

  const optionalErrors = [
    ['runtime errors', runtimeErrorsRes.error],
    ['notification failures', failedNotificationsRes.error],
    ['cron failures', cronErrorsRes.error],
    ['damage reports', damageReportsRes.error],
  ].filter(([, error]) => error);

  const bookingMap = new Map();
  [...(bookingsRes.data || []), ...(financialHoldsRes.data || [])]
    .forEach(booking => bookingMap.set(booking.id, booking));
  const bookings = [...bookingMap.values()];
  const operationalBookings = bookings.filter(booking => !['cancelled', 'declined', 'completed'].includes(booking.status));
  const easers = await Promise.all((easersRes.data || []).map(async easer => ({
    ...easer,
    has_membership: hasEffectiveEaserMembership(easer),
    readiness: await getEaserReadiness(easer, { requireAvailability: false }),
  })));
  const now_ts = now.getTime();
  const activeOffers = activeOffersRes.data || [];
  const activeOfferBookingIds = new Set(activeOffers.map(o => o.booking_id));
  const isDispatchPaymentReady = booking => DISPATCH_PAYMENT_STATUSES.includes(String(booking.payment_status || ''));
  const assignedIds = new Set(operationalBookings.filter(booking => booking.assembler_id).map(booking => booking.assembler_id));
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
  const unassigned = operationalBookings.filter(b =>
    b.status === 'confirmed' && isBookingPaymentReadyForDispatch(b) && !b.assembler_id &&
    !activeOfferBookingIds.has(b.id) && !b.dispatch_offered_at && !b.needs_manual_dispatch
  );

  // awaitingDispatch: has live unexpired offers outstanding right now
  const awaitingDispatch = operationalBookings
    .filter(b =>
      b.status === 'confirmed' && !b.assembler_id &&
      isBookingPaymentReadyForDispatch(b) && activeOfferBookingIds.has(b.id) && !b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'active_offers' }));

  // offersExpired: was dispatched but all offers expired/declined, not yet flagged manual
  const offersExpired = operationalBookings
    .filter(b =>
      b.status === 'confirmed' && !b.assembler_id &&
      isBookingPaymentReadyForDispatch(b) && !activeOfferBookingIds.has(b.id) && b.dispatch_offered_at && !b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'offers_expired' }));

  // needsManual: max attempts reached or explicitly flagged for manual assignment
  const needsManual = operationalBookings
    .filter(b =>
      b.status === 'confirmed' && isBookingPaymentReadyForDispatch(b) && !b.assembler_id && b.needs_manual_dispatch
    )
    .map(b => ({ ...b, _dispatchState: 'needs_manual' }));

  const awaitingAcceptance = operationalBookings.filter(b =>
    b.assembler_id && !b.assembler_accepted_at && b.status === 'confirmed' && isBookingPaymentReadyForDispatch(b)
  );

  const enRoute = operationalBookings.filter(b => b.status === 'en_route');

  // A booking is "arrived" when status = 'arrived' OR it has checked_in_at but no job_started_at
  // (easer-status.js sets status='arrived' when Easer checks in)
  const arrived = operationalBookings.filter(b => b.status === 'arrived');

  const inProgress = operationalBookings.filter(b => b.status === 'in_progress');

  const pendingRows = operationalBookings.filter(b => b.status === 'pending');
  const pendingPayment = pendingRows.filter(b => ['pending', 'failed'].includes(String(b.payment_status || '')));
  const quoteNeedsPricing = pendingRows.filter(b => b.payment_status === 'card_saved');
  const quoteAwaitingApproval = pendingRows.filter(b => b.payment_status === 'quote_pending_approval');
  const quoteAuthorizationPending = pendingRows.filter(b => b.payment_status === 'quote_authorization_pending');
  const pendingOther = pendingRows.filter(b => ![
    'pending',
    'failed',
    'card_saved',
    'quote_pending_approval',
    'quote_authorization_pending',
  ].includes(String(b.payment_status || '')));

  // Backward-compatible field consumed by the current owner page. Restrict it
  // to genuine standard payment recovery so quotes are never labeled as card
  // abandonment. The explicit quote arrays below support the next UI pass.
  const pendingConfirm = pendingPayment;

  const paymentStateMismatches = operationalBookings.filter(booking => {
    const paymentReady = isDispatchPaymentReady(booking);
    if (booking.status === 'pending') return paymentReady;
    if (!['confirmed', 'en_route', 'arrived', 'in_progress'].includes(booking.status)) return false;
    return !isBookingPaymentReadyForDispatch(booking);
  });
  const unreadyOperationalEasers = easers.filter(easer =>
    !easer.readiness?.isReady && (easer.is_available || assignedIds.has(easer.id))
  );

  // ── Alerts ──────────────────────────────────────────────────────
  const alerts = [];

  optionalErrors.forEach(([source, error]) => alerts.push({
    type: 'live_ops_partial_data',
    severity: 'high',
    ref: '',
    bookingId: '',
    message: `Live Ops could not load ${source}. Counts may be incomplete; do not treat zero as confirmed.`,
    detail: error?.message || String(error),
    action: null,
  }));

  const workflowMismatches = operationalBookings.filter(booking => {
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

  paymentStateMismatches.forEach(booking => alerts.push({
    type: 'payment_state_mismatch',
    severity: 'critical',
    ref: booking.ref,
    bookingId: booking.id,
    message: `${booking.ref} has an unsafe booking/payment state (${booking.status} / ${booking.payment_status || 'missing'}). Do not dispatch, complete, refund, or create another payment until Stripe is reconciled.`,
    action: 'review_timeline',
  }));

  operationalBookings.filter(booking => ['cancel_owner', 'cancel_customer', 'cancel_guest'].includes(booking.financial_operation_type)
    && booking.cancellation_reconciliation_required_at).forEach(booking => {
    const recoveryEligibleAt = new Date(new Date(booking.cancellation_reconciliation_required_at).getTime() + 5 * 60 * 1000);
    const validRecoveryTime = Number.isFinite(recoveryEligibleAt.getTime());
    const canOwnerRecover = validRecoveryTime && recoveryEligibleAt.getTime() <= now_ts;
    const recoveryTimeLabel = validRecoveryTime
      ? recoveryEligibleAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
      : 'the five-minute recovery window';
    alerts.push({
      type: 'cancellation_reconciliation_required',
      severity: 'critical',
      ref: booking.ref,
      bookingId: booking.id,
      message: canOwnerRecover
        ? `${booking.ref} cancellation is payment-held. Open the booking and retry Cancel Booking to reconcile Stripe.`
        : `${booking.ref} cancellation is payment-held while the prior request exits. Owner recovery becomes available after ${recoveryTimeLabel}.`,
      detail: booking.cancellation_reconciliation_reason || 'Stripe cancellation truth requires reconciliation.',
      action: 'review_timeline',
    });
  });

  bookings.filter(booking => booking.financial_reconciliation_required_at).forEach(booking => {
    const malformedHold = !booking.financial_operation_key
      || !booking.financial_operation_type
      || !booking.financial_operation_started_at;
    alerts.push({
      type: 'financial_reconciliation_required',
      severity: 'critical',
      ref: booking.ref,
      bookingId: booking.id,
      message: malformedHold
        ? `${booking.ref} has a malformed financial reconciliation hold with no complete operation lock. Do not dispatch, charge, refund, complete, or pay out until it is repaired.`
        : `${booking.ref} has an unresolved ${String(booking.financial_operation_type).replace(/_/g, ' ')} operation. Do not dispatch, charge, refund, complete, or pay out until its exact Stripe/database state is reconciled.`,
      detail: booking.financial_reconciliation_reason || 'A financial operation did not reach a safely verified final state.',
      action: 'review_timeline',
    });
  });

  unreadyOperationalEasers.forEach(easer => {
    const activeAssignment = operationalBookings.find(booking => booking.assembler_id === easer.id) || null;
    alerts.push({
      type: 'easer_readiness_mismatch',
      severity: activeAssignment ? 'critical' : 'high',
      ref: activeAssignment?.ref || '',
      bookingId: activeAssignment?.id || '',
      message: `${easer.full_name || 'An Easer'} ${activeAssignment ? `is assigned to ${activeAssignment.ref} but` : 'is marked online but'} is not ready for jobs: ${(easer.readiness?.missingItems || ['readiness could not be verified']).join(', ')}.`,
      action: activeAssignment ? 'review_timeline' : null,
    });
  });

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
    const booking = operationalBookings.find(row => row.id === offer.booking_id);
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
  operationalBookings.filter(b => !b.assembler_id && b.status === 'confirmed' && isBookingPaymentReadyForDispatch(b)).forEach(b => {
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
  const todayUnassigned = operationalBookings.filter(b =>
    b.date === todayStr && !b.assembler_id && b.status === 'confirmed' && isBookingPaymentReadyForDispatch(b)
  );
  todayUnassigned.forEach(b => alerts.push({
    type: 'today_unassigned',
    severity: 'critical',
    ref: b.ref,
    bookingId: b.id,
    message: `TODAY: ${b.service} at ${b.time || 'TBD'} — no Easer assigned`,
    action: 'dispatch',
  }));

  // Incomplete standard card authorizations older than 1hr
  pendingPayment.filter(b => {
    const age = (now_ts - new Date(b.created_at).getTime()) / 3600000;
    return age > 1;
  }).forEach(b => alerts.push({
    type: b.payment_status === 'failed' ? 'payment_failed_recovery' : 'stale_pending_payment',
    severity: b.stripe_payment_intent_id ? 'medium' : 'high',
    ref: b.ref,
    bookingId: b.id,
    message: `${b.ref} — ${b.payment_status === 'failed' ? 'card authorization failed' : 'card authorization incomplete'} for ${Math.round((now_ts - new Date(b.created_at).getTime()) / 3600000)}h`,
    action: 'review_timeline',
  }));

  quoteNeedsPricing.forEach(b => alerts.push({
    type: 'quote_needs_pricing',
    severity: 'medium',
    ref: b.ref,
    bookingId: b.id,
    message: `${b.ref} — quote request has a saved card and needs owner pricing`,
    action: 'review_timeline',
  }));

  quoteAwaitingApproval.forEach(b => {
    const expired = !b.quote_expires_at || Date.parse(b.quote_expires_at) <= now_ts;
    alerts.push({
      type: expired ? 'quote_expired_needs_reconciliation' : 'quote_awaiting_customer',
      severity: expired ? 'high' : 'low',
      ref: b.ref,
      bookingId: b.id,
      message: `${b.ref} — ${expired ? 'quote approval expired and needs state review' : 'waiting for customer quote approval'}`,
      action: 'review_timeline',
    });
  });

  quoteAuthorizationPending.forEach(b => alerts.push({
    type: 'quote_authorization_pending',
    severity: 'high',
    ref: b.ref,
    bookingId: b.id,
    message: `${b.ref} — quote authorization started but confirmation is not complete; reconcile Stripe before changing status`,
    action: 'review_timeline',
  }));

  pendingOther.forEach(b => alerts.push({
    type: 'unknown_pending_payment_state',
    severity: 'high',
    ref: b.ref,
    bookingId: b.id,
    message: `${b.ref} — unknown pending payment state (${b.payment_status || 'missing'}); review before dispatch or expiry`,
    action: 'review_timeline',
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

  // Map assembler_id → their active booking's pipeline stage (en_route, arrived, in_progress, confirmed)
  const assemblerStageMap = {};
  operationalBookings.filter(b => b.assembler_id).forEach(b => {
    assemblerStageMap[b.assembler_id] = b.pipeline_stage || b.status;
  });
  const rosterEasers = easers.filter(e => e.readiness?.ownerApproved && e.readiness?.tierEligible);
  const onlineEasers = rosterEasers.filter(e => e.is_available && e.readiness?.isReady);
  const offlineEasers = rosterEasers.filter(e => !e.is_available || !e.readiness?.isReady);
  const busyEasers = onlineEasers.filter(e => assignedIds.has(e.id));
  const freeEasers = onlineEasers.filter(e => !assignedIds.has(e.id));

  // ── Today's schedule ─────────────────────────────────────────────
  const todayAll = operationalBookings.filter(b => b.date === todayStr);

  return res.status(200).json({
    generatedAt: now.toISOString(),
    summary: {
      // Exclude 'pending' (awaiting payment) from Active Jobs count so the
      // chip matches what's actually shown in the Active Jobs panel.
      totalActive: operationalBookings.filter(b => b.status !== 'pending').length,
      pendingPayment: pendingPayment.length,
      quoteNeedsPricing: quoteNeedsPricing.length,
      quoteAwaitingApproval: quoteAwaitingApproval.length,
      quoteAuthorizationPending: quoteAuthorizationPending.length,
      pendingOther: pendingOther.length,
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
      paymentStateMismatches: paymentStateMismatches.length,
      unreadyEasers: unreadyOperationalEasers.length,
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
    pendingPayment,
    quoteNeedsPricing,
    quoteAwaitingApproval,
    quoteAuthorizationPending,
    pendingOther,
    paymentStateMismatches,
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
    partial: optionalErrors.length > 0,
    warnings: optionalErrors.map(([source, error]) => `${source}: ${error.message || error}`),
  });
}
