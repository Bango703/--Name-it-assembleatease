import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';
import { buildRequestId, hashIdentifier, getDeploymentMetadata, normalizeReasonCode, redactString } from '../_observability.js';

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

  // ── Path 1: dispatch_offers table (new) ───────────────────────────────────
  const { data: offer } = await sb
    .from('dispatch_offers')
    .select('*')
    .eq('token', token)
    .eq('booking_id', bookingId)
    .eq('easer_id', assemblerId)
    .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
    .maybeSingle();

  if (offer) {
    // Verify offer not expired
    if (new Date(offer.expires_at) < new Date()) {
      await sb.from('dispatch_offers')
        .update({ offer_status: DISPATCH_OFFER_STATUS.EXPIRED, timed_out_at: now })
        .eq('id', offer.id);
      return res.status(410).json({ error: 'Sorry — this job offer has expired. Check your dashboard for new opportunities.' });
    }

    // Verify booking still exists and is available
    const { data: booking } = await sb.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BOOKING_STATUS.CONFIRMED) return res.status(400).json({ error: 'This booking is no longer available' });
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });

    // Get Easer profile and enforce operational eligibility at accept time
    const { data: easer } = await sb.from('profiles').select('*').eq('id', assemblerId).single();
    if (!easer) return res.status(404).json({ error: 'Easer profile not found' });
    {
      const eligibility = getEaserEligibility(easer);
      if (!eligibility.ok) {
        return res.status(403).json({ error: eligibility.error });
      }
    }

    // ── Atomic CAS: assign only if assembler_id is still null ───────────────
    // .select('id') returns the updated row(s). If 0 rows returned, the guard
    // condition failed — another Easer won the race. No separate read needed.
    const { data: assignedRows, error: assignErr } = await sb.from('bookings').update({
      assembler_id:          assemblerId,
      assembler_name:        easer.full_name,
      assembler_tier:        easer.tier,
      assigned_at:           now,
      assembler_accepted_at: now,
      dispatch_status:       'accepted',
      dispatch_token:        null,
      assignment_token:      null,
    })
    .eq('id', bookingId)
    .is('assembler_id', null)
    .select('id');

    if (assignErr || !assignedRows || assignedRows.length === 0) {
      return res.status(409).json({ error: 'Sorry — another Easer accepted this job first.' });
    }

    // Mark this offer accepted
    await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.ACCEPTED, accepted_at: now })
      .eq('id', offer.id);

    // Supersede all other open offers for this booking
    await sb.from('dispatch_offers')
      .update({ offer_status: DISPATCH_OFFER_STATUS.SUPERSEDED })
      .eq('booking_id', bookingId)
      .eq('offer_status', DISPATCH_OFFER_STATUS.SENT)
      .neq('id', offer.id);

    // Update Easer's last_assigned_at for fairness scoring
    await sb.from('profiles')
      .update({ last_assigned_at: now })
      .eq('id', assemblerId);

    // Increment active_jobs_today — the CAS guard ensures this runs exactly once
    adjustActiveJobs(sb, assemblerId, +1).catch(() => {});

    logActivity(sb, {
      bookingId,
      eventType: 'easer_accepted',
      actorType: 'easer',
      actorId: assemblerId,
      actorName: easer.full_name,
      description: `${easer.full_name} accepted the job via dispatch offer`,
      metadata: { tier: easer.tier, score: offer.dispatch_score, attempt: offer.attempt_number },
    });

    sendNotifications(sb, booking, easer, assemblerId);
    return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
  }

  // ── Path 2: Legacy inline tokens (assignment_token or dispatch_token) ─────
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status !== BOOKING_STATUS.CONFIRMED) return res.status(400).json({ error: 'This booking is no longer available' });

  const isDispatch   = booking.dispatch_token && booking.dispatch_token === token;
  const isAssignment = booking.assignment_token && booking.assignment_token === token
                    && booking.assembler_id === assemblerId;

  if (!isDispatch && !isAssignment) {
    return res.status(403).json({ error: 'Invalid or expired offer token' });
  }

  if (isDispatch) {
    if (booking.assembler_id) return res.status(409).json({ error: 'Sorry — another Easer just accepted this job.' });
    const offeredTo = booking.dispatch_offered_to || [];
    if (!offeredTo.includes(assemblerId)) {
      return res.status(403).json({ error: 'This job offer was not sent to your account' });
    }
  }

  const { data: easer } = await sb.from('profiles').select('*').eq('id', assemblerId).single();
  if (!easer) return res.status(404).json({ error: 'Easer profile not found' });
  {
    const eligibility = getEaserEligibility(easer);
    if (!eligibility.ok) {
      return res.status(403).json({ error: eligibility.error });
    }
  }

  const updateData = {
    assembler_accepted_at: now,
    dispatch_status: 'accepted',
    dispatch_token: null,
    assignment_token: null,
  };
  if (isDispatch) {
    Object.assign(updateData, {
      assembler_id: assemblerId,
      assembler_name: easer.full_name,
      assembler_tier: easer.tier,
      assigned_at: now,
    });
  }

  const updateQuery = sb.from('bookings').update(updateData).eq('id', bookingId);
  const { error: assignErr } = isDispatch
    ? await updateQuery.is('assembler_id', null)
    : await updateQuery;

  if (assignErr) return res.status(409).json({ error: 'Sorry — another Easer accepted this job first' });

  await sb.from('profiles').update({ last_assigned_at: now }).eq('id', assemblerId);

  logActivity(sb, {
    bookingId,
    eventType: 'easer_accepted',
    actorType: 'easer',
    actorId: assemblerId,
    actorName: easer.full_name,
    description: `${easer.full_name} accepted the job (legacy token)`,
    metadata: { tier: easer.tier },
  });

  sendNotifications(sb, booking, easer, assemblerId);
  return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
}

function sendNotifications(sb, booking, easer, assemblerId) {
  const bookingId = booking.id;

  // Customer: "Your Easer is confirmed"
  if (booking.customer_email) {
    sendEmail({
      to:   booking.customer_email,
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Your Easer is confirmed — ${esc(booking.ref)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h2 style="color:#00BFFF">Your Easer is confirmed!</h2>
        <p>Hi ${esc((booking.customer_name||'').split(' ')[0])},</p>
        <p>A professional Easer has been assigned to your job and will arrive on <strong>${esc(booking.date)}</strong> at <strong>${esc(booking.time||'the scheduled time')}</strong>.</p>
        <p>You will receive another notification when your Easer is on their way.</p>
        <p style="color:#6b7280;font-size:0.85rem">Booking ref: ${esc(booking.ref)}</p>
      </div>`,
      replyTo: ownerEmail(),
      meta: { bookingId, notificationType: 'job_accepted', recipientType: 'customer' },
    }).catch(() => {});
  }

  // Owner: "Job Accepted"
  sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job Accepted — ${esc(booking.ref)} · ${esc(easer.full_name)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#00BFFF">Job Accepted</h2>
      <p><strong>${esc(easer.full_name)}</strong> (${esc(easer.tier)}${easer.has_membership?' · Member':''}) accepted booking <strong>${esc(booking.ref)}</strong>.</p>
      <p><strong>Service:</strong> ${esc(booking.service)}<br>
      <strong>Date:</strong> ${esc(booking.date)} at ${esc(booking.time||'TBD')}<br>
      <strong>Customer:</strong> ${esc(booking.customer_name)}</p>
      <p><a href="https://www.assembleatease.com/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
    </div>`,
    meta: { bookingId, notificationType: 'job_accepted', recipientType: 'owner' },
  }).catch(() => {});
}

function getEaserEligibility(profile) {
  if (!profile) {
    return { ok: false, error: 'Easer profile not found' };
  }

  const tier = String(profile.tier || '').toLowerCase();
  const applicationStatus = String(profile.application_status || '').toLowerCase();
  let status = String(profile.status || '').toLowerCase();

  // Backwards-compatible status derivation in case status is unset on legacy rows.
  if (!status) {
    if (applicationStatus === 'rejected' || tier === 'rejected') status = 'rejected';
    else if (tier === 'suspended') status = 'suspended';
    else if (tier === 'pending' || !tier) status = 'pending';
    else status = 'active';
  }

  if (status !== 'active') {
    return { ok: false, error: 'Your Easer account is not eligible to accept jobs right now.' };
  }

  if (profile.identity_verified !== true) {
    return { ok: false, error: 'Identity verification is required before accepting jobs.' };
  }

  if (!['starter', 'professional', 'elite'].includes(tier)) {
    return { ok: false, error: 'Your Easer tier is not eligible for job acceptance.' };
  }

  if (isStripeConnectEnabled()) {
    if (!profile.stripe_connect_onboarding_complete || !profile.stripe_connect_charges_enabled || !profile.stripe_connect_payouts_enabled) {
      return { ok: false, error: 'Complete Stripe payout setup before accepting jobs.' };
    }
  }

  return { ok: true };
}
