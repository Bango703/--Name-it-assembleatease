import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc, buildStatusEmail } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, isBookingPaymentReadyForDispatch } from '../_source-of-truth.js';
import { buildRequestId, hashIdentifier, getDeploymentMetadata, normalizeReasonCode, redactString } from '../_observability.js';
import { getEaserReadiness, readinessError } from '../_easer-readiness.js';
import { isLegacyAssignmentTokenFresh } from './_dispatch-safety.js';
import { buildEaserFeeSnapshot } from './_easer-fee-snapshot.js';
import { hasEffectiveEaserMembership } from '../_easer-membership.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/accept-dispatch
 * Easer accepts a dispatched job offer.
 * Requires Bearer JWT — assemblerId is taken from the verified token, not the body.
 * Supports: dispatch_offers table (new) and legacy inline tokens (backwards compat).
 * Body: { bookingId, token }
 */
export default async function handler(req, res) {
  let requestId = 'obs_fallback';
  try {
    requestId = buildRequestId(req.headers || {});
  } catch (_) {}

  const requestStartedAt = Date.now();
  let deployment = {
    deployment_id: null,
    commit_sha: null,
    environment: null,
    app_version: null,
  };
  try {
    deployment = { ...deployment, ...(getDeploymentMetadata() || {}) };
  } catch (_) {}

  let actorIdHash = null;
  let bookingHash = null;
  let offerHash = null;
  let attemptEventEmitted = false;
  let terminalEventEmitted = false;
  const responseObservation = {
    category: null,
    errorHint: null,
  };

  const scheduleTelemetry = (row) => {
    if (!row) return;
    try {
      void Promise.resolve()
        .then(() => {
          try {
            const sbObs = getSupabase();
            return sbObs.from('operational_events').insert(row);
          } catch (_) {
            return null;
          }
        })
        .catch(() => {});
    } catch (_) {}
  };

  const emitAttemptEvent = () => {
    if (attemptEventEmitted) return;
    attemptEventEmitted = true;
    scheduleTelemetry({
      event_type: 'accept_dispatch_attempt',
      request_id: requestId,
      route: '/api/booking/accept-dispatch',
      method: req.method,
      deployment_id: deployment.deployment_id,
      commit_sha: deployment.commit_sha,
      environment: deployment.environment,
      app_version: deployment.app_version,
      actor_role: 'easer',
      actor_id_hash: actorIdHash,
      booking_hash: bookingHash,
      offer_hash: offerHash,
      stage: 'request_validated',
      status_code: null,
      reason_code: null,
      reason_detail: null,
      mutation_result: null,
      latency_ms: Date.now() - requestStartedAt,
      payload: null,
    });
  };

  const deriveReasonCode = (statusCode, errorHint) => {
    const hint = String(errorHint || '').toLowerCase();
    if (statusCode === 401) {
      return hint === 'unauthorized' ? 'unauthorized_missing_bearer' : 'unauthorized_invalid_token';
    }
    if (statusCode === 400) {
      return hint.includes('required') ? 'invalid_input' : 'booking_not_confirmed';
    }
    if (statusCode === 404) {
      return hint.includes('profile') ? 'profile_not_found' : 'booking_not_found';
    }
    if (statusCode === 409) {
      return hint.includes('first') ? 'race_lost' : 'booking_already_assigned';
    }
    if (statusCode === 410) {
      return 'offer_expired';
    }
    if (statusCode === 403) {
      if (hint.includes('identity')) return 'ineligible_identity';
      if (hint.includes('not eligible') || hint.includes('tier')) return 'ineligible_status';
      return 'legacy_token_invalid';
    }
    return null;
  };

  const emitTerminalEvent = (terminalSource) => {
    if (terminalEventEmitted) return;
    terminalEventEmitted = true;

    const statusCode = Number.isInteger(res.statusCode) ? res.statusCode : 500;
    const isSuccess = statusCode >= 200 && statusCode < 300;
    const explicitReason = deriveReasonCode(statusCode, responseObservation.errorHint);

    scheduleTelemetry({
      event_type: isSuccess ? 'accept_dispatch_success' : 'accept_dispatch_reject',
      request_id: requestId,
      route: '/api/booking/accept-dispatch',
      method: req.method,
      deployment_id: deployment.deployment_id,
      commit_sha: deployment.commit_sha,
      environment: deployment.environment,
      app_version: deployment.app_version,
      actor_role: 'easer',
      actor_id_hash: actorIdHash,
      booking_hash: bookingHash,
      offer_hash: offerHash,
      stage: terminalSource,
      status_code: statusCode,
      reason_code: normalizeReasonCode({ reasonCode: explicitReason, statusCode }),
      reason_detail: redactString(responseObservation.errorHint) || null,
      mutation_result: isSuccess ? 'accepted' : 'rejected',
      latency_ms: Date.now() - requestStartedAt,
      payload: {
        response_category: responseObservation.category || null,
      },
    });
  };

  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function observedJson(body) {
    try {
      if (body && typeof body === 'object') {
        if (body.ok === true) responseObservation.category = 'ok';
        else if (typeof body.error === 'string') {
          responseObservation.category = 'error';
          responseObservation.errorHint = redactString(body.error) || null;
        } else responseObservation.category = 'object';
      } else if (typeof body === 'string') {
        responseObservation.category = 'text';
      }
    } catch (_) {}
    return originalJson(body);
  };

  res.send = function observedSend(body) {
    try {
      if (!responseObservation.category) {
        if (typeof body === 'string') responseObservation.category = 'text';
        else if (body && typeof body === 'object') responseObservation.category = 'object';
      }
    } catch (_) {}
    return originalSend(body);
  };

  res.once('finish', () => {
    emitTerminalEvent('response_finish');
  });

  res.once('close', () => {
    emitTerminalEvent('response_close');
  });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT — assemblerId MUST come from the token, not the request body
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { bookingId, token } = req.body;
  if (!bookingId || !token) {
    return res.status(400).json({ error: 'bookingId and token are required' });
  }

  // Identity is the JWT user — never trust body-supplied assemblerId
  const assemblerId = user.id;
  actorIdHash = hashIdentifier(assemblerId, { prefix: 'ea' });
  bookingHash = hashIdentifier(bookingId, { prefix: 'bk' });
  offerHash = hashIdentifier(token, { prefix: 'of' });
  emitAttemptEvent();

  const sb = getSupabase();
  const now = new Date().toISOString();

  // Authentication proves a user identity, not an Easer role. Fail closed
  // before even resolving/expiring an offer so a role-revoked account cannot
  // mutate dispatch state. Full readiness is checked again before acceptance.
  const { data: actorProfile, error: actorProfileError } = await sb
    .from('profiles')
    .select('id, role')
    .eq('id', assemblerId)
    .maybeSingle();
  if (actorProfileError) {
    console.error('accept-dispatch actor role lookup error:', actorProfileError);
    return res.status(503).json({ error: 'Easer role could not be verified. The job was not accepted.' });
  }
  if (!actorProfile || actorProfile.role !== 'assembler') {
    return res.status(403).json({ error: 'An Easer account is required to accept job offers.' });
  }

  // ── Path 1: dispatch_offers table (new) ───────────────────────────────────
  const { data: offer, error: offerLookupErr } = await sb
    .from('dispatch_offers')
    .select('*')
    .eq('token', token)
    .eq('booking_id', bookingId)
    .eq('easer_id', assemblerId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .maybeSingle();

  if (offerLookupErr) {
    console.error('accept-dispatch offer lookup error:', offerLookupErr);
    return res.status(500).json({ error: 'Could not verify this offer. Please try again.' });
  }

  if (offer) {
    // Verify offer not expired
    if (new Date(offer.expires_at) < new Date()) {
      await sb.from('dispatch_offers')
        .update({ offer_status: DISPATCH_OFFER_STATUS.EXPIRED, timed_out_at: now })
        .eq('id', offer.id)
        .eq('offer_status', DISPATCH_OFFER_STATUS.SENT);
      return res.status(410).json({ error: 'Sorry — this job offer has expired. Check your dashboard for new opportunities.' });
    }

    // Verify booking still exists and is available
    const { data: booking, error: bookingLookupError } = await sb.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (bookingLookupError) {
      console.error('accept-dispatch booking lookup error:', bookingLookupError);
      return res.status(500).json({ error: 'Could not verify this booking. Please try again.' });
    }
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BOOKING_STATUS.CONFIRMED) return res.status(400).json({ error: 'This booking is no longer available' });
    if (!isBookingPaymentReadyForDispatch(booking)) {
      return res.status(409).json({ error: 'This booking is on payment hold and cannot be accepted.', code: 'DISPATCH_PAYMENT_NOT_VERIFIED' });
    }
    if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
      return res.status(409).json({ error: 'This booking is temporarily locked while a financial operation finishes.' });
    }
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });

    // Get Easer profile and enforce operational eligibility at accept time
    const { data: easer, error: easerLookupError } = await sb.from('profiles').select('*').eq('id', assemblerId).maybeSingle();
    if (easerLookupError) {
      console.error('accept-dispatch Easer profile lookup error:', easerLookupError);
      return res.status(503).json({ error: 'Easer membership status could not be verified. The job was not accepted.' });
    }
    if (!easer) return res.status(404).json({ error: 'Easer profile not found' });
    if (easer.role !== 'assembler') {
      return res.status(403).json({ error: 'An Easer account is required to accept job offers.' });
    }
    {
      const readiness = await getEaserReadiness(easer);
      if (!readiness.isReady) {
        return res.status(403).json({ error: readinessError(readiness), missingItems: readiness.missingItems });
      }
    }
    let feeSnapshot;
    try {
      feeSnapshot = buildEaserFeeSnapshot(booking, easer, { snapshottedAt: now });
    } catch (snapshotError) {
      console.error('accept-dispatch Easer fee snapshot error:', snapshotError);
      return res.status(503).json({ error: 'Easer membership status could not be verified. The job was not accepted.' });
    }

    // Accept the offer and assign the booking in one row-locked transaction.
    // This is the final CAS against the exact confirmed/unassigned dispatch
    // attempt, so cancellation, decline, expiry, and owner assignment races
    // cannot leave the two tables disagreeing.
    const { data: acceptResult, error: claimErr } = await sb.rpc('accept_dispatch_offer', {
      p_offer_id: offer.id,
      p_booking_id: bookingId,
      p_easer_id: assemblerId,
      p_expected_attempt: offer.attempt_number,
      p_easer_name: easer.full_name,
      p_easer_tier: easer.tier,
      p_easer_fee_pct_snapshot: feeSnapshot.feePct,
      p_easer_estimated_due_snapshot: feeSnapshot.estimatedDueCents,
      p_easer_fee_snapshot_at: feeSnapshot.snapshottedAt,
      p_accepted_at: now,
    });

    if (claimErr) {
      console.error('accept-dispatch atomic accept error:', claimErr);
      const guardConflict = ['23503', '23514', '40001'].includes(claimErr.code)
        || /Easer|assignment|readiness|eligible|closure|available/i.test(claimErr.message || '');
      return res.status(guardConflict ? 409 : 500).json({
        error: guardConflict
          ? 'Your Easer readiness changed before acceptance. Review your checklist, then try again.'
          : 'Could not accept this offer. Please try again.',
        code: guardConflict ? 'EASER_ACCEPTANCE_READINESS_CHANGED' : 'DISPATCH_ACCEPT_FAILED',
      });
    }
    const accepted = Array.isArray(acceptResult) ? acceptResult[0] : acceptResult;
    if (accepted?.result_action === 'expired') {
      return res.status(410).json({ error: 'Sorry — this job offer has expired. Check your dashboard for new opportunities.' });
    }
    if (accepted?.result_action !== 'accepted') {
      return res.status(409).json({ error: 'Sorry — this job is no longer available.' });
    }

    // Update Easer's last_assigned_at for fairness scoring
    await sb.from('profiles')
      .update({ last_assigned_at: now })
      .eq('id', assemblerId);

    // Increment active_jobs_today — the CAS guard ensures this runs exactly once
    adjustActiveJobs(sb, assemblerId, +1).catch(() => {});

    await logActivity(sb, {
      bookingId,
      eventType: 'easer_accepted',
      actorType: 'easer',
      actorId: assemblerId,
      actorName: easer.full_name,
      description: `${easer.full_name} accepted the job via dispatch offer`,
      metadata: {
        tier: easer.tier,
        score: offer.dispatch_score,
        attempt: offer.attempt_number,
        easerFeePctSnapshot: feeSnapshot.feePct,
        easerEstimatedDueSnapshot: feeSnapshot.estimatedDueCents,
      },
    });

    const notification = await sendNotifications(sb, booking, easer, assemblerId);
    return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref, notification });
  }

  // ── Path 2: Legacy inline tokens (assignment_token or dispatch_token) ─────
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== BOOKING_STATUS.CONFIRMED) return res.status(400).json({ error: 'This booking is no longer available' });
  if (!isBookingPaymentReadyForDispatch(booking)) {
    return res.status(409).json({ error: 'This booking is on payment hold and cannot be accepted.', code: 'DISPATCH_PAYMENT_NOT_VERIFIED' });
  }

  const isDispatch   = booking.dispatch_token && booking.dispatch_token === token;
  const isAssignment = booking.assignment_token && booking.assignment_token === token
                    && booking.assembler_id === assemblerId;

  if (!isDispatch && !isAssignment) {
    return res.status(403).json({ error: 'Invalid or expired offer token' });
  }
  if (booking.financial_operation_key || booking.financial_operation_type || booking.financial_operation_started_at) {
    return res.status(409).json({ error: 'This booking is temporarily locked while a financial operation finishes.' });
  }

  if (isAssignment && !isLegacyAssignmentTokenFresh(booking)) {
    await sb.from('bookings')
      .update({ assignment_token: null })
      .eq('id', bookingId)
      .eq('assembler_id', assemblerId)
      .eq('assignment_token', token);
    return res.status(410).json({ error: 'This assignment link has expired. Ask the owner to resend or reassign the job.' });
  }

  if (isDispatch) {
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });
    const offeredTo = booking.dispatch_offered_to || [];
    if (!offeredTo.includes(assemblerId)) {
      return res.status(403).json({ error: 'This job offer was not sent to your account' });
    }
  }

  const { data: easer, error: easerLookupError } = await sb.from('profiles').select('*').eq('id', assemblerId).maybeSingle();
  if (easerLookupError) {
    console.error('accept-dispatch legacy Easer profile lookup error:', easerLookupError);
    return res.status(503).json({ error: 'Easer membership status could not be verified. The job was not accepted.' });
  }
  if (!easer) return res.status(404).json({ error: 'Easer profile not found' });
  if (easer.role !== 'assembler') {
    return res.status(403).json({ error: 'An Easer account is required to accept job offers.' });
  }
  {
    const readiness = await getEaserReadiness(easer);
    if (!readiness.isReady) {
      return res.status(403).json({ error: readinessError(readiness), missingItems: readiness.missingItems });
    }
  }
  let feeSnapshot;
  try {
    feeSnapshot = buildEaserFeeSnapshot(booking, easer, { snapshottedAt: now });
  } catch (snapshotError) {
    console.error('accept-dispatch legacy Easer fee snapshot error:', snapshotError);
    return res.status(503).json({ error: 'Easer membership status could not be verified. The job was not accepted.' });
  }

  const updateData = {
    assembler_accepted_at: now,
    dispatch_status: 'accepted',
    dispatch_token: null,
    assignment_token: null,
    ...feeSnapshot.updates,
  };
  if (isDispatch) {
    Object.assign(updateData, {
      assembler_id: assemblerId,
      assembler_name: easer.full_name,
      assembler_tier: easer.tier,
      assigned_at: now,
    });
  }

  let updateQuery = sb.from('bookings').update(updateData)
    .eq('id', bookingId)
    .eq('status', BOOKING_STATUS.CONFIRMED)
    .eq('payment_status', booking.payment_status)
    .is('financial_operation_key', null)
    .is('financial_operation_type', null)
    .is('financial_operation_started_at', null);
  updateQuery = booking.total_price == null
    ? updateQuery.is('total_price', null)
    : updateQuery.eq('total_price', booking.total_price);
  updateQuery = booking.stripe_payment_intent_id == null
    ? updateQuery.is('stripe_payment_intent_id', null)
    : updateQuery.eq('stripe_payment_intent_id', booking.stripe_payment_intent_id);
  updateQuery = booking.stripe_deposit_intent_id == null
    ? updateQuery.is('stripe_deposit_intent_id', null)
    : updateQuery.eq('stripe_deposit_intent_id', booking.stripe_deposit_intent_id);
  const { data: acceptedRows, error: assignErr } = isDispatch
    ? await updateQuery.is('assembler_id', null).eq('dispatch_token', token).select('id')
    : await updateQuery.eq('assembler_id', assemblerId).eq('assignment_token', token).select('id');

  if (assignErr || !acceptedRows?.length) return res.status(409).json({ error: 'Sorry — this job is no longer available.' });

  await sb.from('profiles').update({ last_assigned_at: now }).eq('id', assemblerId);

  await logActivity(sb, {
    bookingId,
    eventType: 'easer_accepted',
    actorType: 'easer',
    actorId: assemblerId,
    actorName: easer.full_name,
    description: `${easer.full_name} accepted the job (legacy token)`,
    metadata: {
      tier: easer.tier,
      easerFeePctSnapshot: feeSnapshot.feePct,
      easerEstimatedDueSnapshot: feeSnapshot.estimatedDueCents,
    },
  });

  const notification = await sendNotifications(sb, booking, easer, assemblerId);
  return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref, notification });
}

async function sendNotifications(sb, booking, easer, assemblerId) {
  const bookingId = booking.id;
  const results = [];

  // Customer: "Your Easer is confirmed"
  if (booking.customer_email) {
    const result = await sendEmail({
      to:   booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your Easer is confirmed — ${esc(booking.ref)}`,
      html: buildStatusEmail({
        customerName: (booking.customer_name || '').split(' ')[0],
        ref: booking.ref,
        status: 'Confirmed',
        statusColor: '#065f46',
        statusBg: '#d1fae5',
        headline: 'Your Easer is confirmed.',
        bodyHtml: `<p style="margin:0;font-size:15px;color:#52525b;line-height:1.7">Hi ${esc((booking.customer_name || '').split(' ')[0])}, good news — <strong>${esc(easer.full_name || 'your Easer')}</strong> will be handling your <strong>${esc(booking.service)}</strong> on <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time || 'the scheduled time')}</strong>. We'll send another note when they're on the way.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0"><tr><td style="text-align:center"><a href="https://www.assembleatease.com/track?ref=${encodeURIComponent(booking.ref)}" style="display:inline-block;background:#00BFFF;color:#ffffff;font-size:14px;font-weight:600;padding:12px 32px;border-radius:6px;text-decoration:none">Track your booking</a></td></tr></table>
        <p style="margin:18px 0 0;font-size:14px;color:#52525b;line-height:1.7">Questions before then? Call or text us at <a href="tel:+17372906129" style="color:#00BFFF;text-decoration:none">737-290-6129</a>.</p>`,
      }),
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: 'job_accepted', recipientType: 'customer' },
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));
    results.push({ recipient: 'customer', ...result });
  }

  // Owner: "Job Accepted"
  const ownerResult = await sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job Accepted — ${esc(booking.ref)} · ${esc(easer.full_name)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#00BFFF">Job Accepted</h2>
      <p><strong>${esc(easer.full_name)}</strong> (${esc(easer.tier)}${hasEffectiveEaserMembership(easer) ? ' · Member' : ''}) accepted booking <strong>${esc(booking.ref)}</strong>.</p>
      <p><strong>Service:</strong> ${esc(booking.service)}<br>
      <strong>Date:</strong> ${esc(booking.date)} at ${esc(booking.time||'TBD')}<br>
      <strong>Customer:</strong> ${esc(booking.customer_name)}</p>
      <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
    </div>`,
    meta: { bookingId, notificationType: 'job_accepted', recipientType: 'owner' },
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));
  results.push({ recipient: 'owner', ...ownerResult });

  const failures = results.filter(result => !result.ok);
  if (failures.length) {
    await logActivity(sb, {
      bookingId,
      eventType: 'acceptance_notification_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `Job acceptance saved, but ${failures.map(f => f.recipient).join(' and ')} notification failed`,
      metadata: { failures },
    });
  }
  const auditFailures = results.filter(result => result.logged === false);
  if (auditFailures.length) {
    await logActivity(sb, {
      bookingId,
      eventType: 'notification_audit_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: 'Job acceptance notifications were attempted, but one or more attempt logs could not be saved',
      metadata: { failures: auditFailures.map(result => ({ recipient: result.recipient, error: result.logError || null })) },
    });
  }
  return { delivered: results.filter(result => result.ok).map(result => result.recipient), failures, auditFailures };
}
