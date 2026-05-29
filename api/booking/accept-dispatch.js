import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { sendPushToUser } from '../_push.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { buildRequestId, hashIdentifier, getDeploymentMetadata, insertOperationalEventFailOpen } from '../_observability.js';

const SITE = 'https://www.assembleatease.com';

/**
 * POST /api/booking/accept-dispatch
 * Easer accepts a dispatched job offer.
 * Requires Bearer JWT — assemblerId is taken from the verified token, not the body.
 * Supports: dispatch_offers table (new) and legacy inline tokens (backwards compat).
 * Body: { bookingId, token }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const requestId = buildRequestId(req.headers || {});
  const requestStartedAt = Date.now();
  const deployment = getDeploymentMetadata();
  let attemptEventEmitted = false;
  let terminalEventEmitted = false;

  const emitAttemptEvent = async ({ actorIdHash = null, bookingHash = null, offerHash = null } = {}) => {
    if (attemptEventEmitted) return;
    attemptEventEmitted = true;

    await insertOperationalEventFailOpen(getSupabase(), {
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
      payload: { has_auth_header: !!auth },
    });
  };

  const emitTerminalEvent = async (eventType, {
    statusCode,
    reasonCode,
    reasonDetail,
    stage,
    mutationResult,
    actorIdHash = null,
    bookingHash = null,
    offerHash = null,
    payload = null,
  } = {}) => {
    if (terminalEventEmitted) return;
    terminalEventEmitted = true;

    await insertOperationalEventFailOpen(getSupabase(), {
      event_type: eventType,
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
      stage,
      status_code: statusCode,
      reason_code: reasonCode,
      reason_detail: reasonDetail,
      mutation_result: mutationResult,
      latency_ms: Date.now() - requestStartedAt,
      payload,
    });
  };

  const rejectWithTelemetry = async (statusCode, body, telemetry = {}) => {
    await emitTerminalEvent('accept_dispatch_reject', {
      statusCode,
      reasonCode: telemetry.reasonCode,
      reasonDetail: body?.error,
      stage: telemetry.stage,
      mutationResult: 'rejected',
      actorIdHash: telemetry.actorIdHash,
      bookingHash: telemetry.bookingHash,
      offerHash: telemetry.offerHash,
      payload: telemetry.payload || null,
    });
    return res.status(statusCode).json(body);
  };

  // Verify JWT — assemblerId MUST come from the token, not the request body
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return rejectWithTelemetry(401, { error: 'Unauthorized' }, {
      reasonCode: 'unauthorized_missing_bearer',
      stage: 'auth_header',
    });
  }

  try {
    const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
    if (authErr || !user) {
      return rejectWithTelemetry(401, { error: 'Invalid or expired token' }, {
        reasonCode: 'unauthorized_invalid_token',
        stage: 'auth_user',
      });
    }

    const { bookingId, token } = req.body;
    if (!bookingId || !token) {
      return rejectWithTelemetry(400, { error: 'bookingId and token are required' }, {
        reasonCode: 'invalid_input',
        stage: 'request_body',
      });
    }

    // Identity is the JWT user — never trust body-supplied assemblerId
    const assemblerId = user.id;
    const actorIdHash = hashIdentifier(assemblerId, { prefix: 'ea' });
    const bookingHash = hashIdentifier(bookingId, { prefix: 'bk' });
    const offerHash = hashIdentifier(token, { prefix: 'of' });

    await emitAttemptEvent({ actorIdHash, bookingHash, offerHash });

    const sb = getSupabase();
    const now = new Date().toISOString();

    // ── Path 1: dispatch_offers table (new) ─────────────────────────────────
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
        return rejectWithTelemetry(410, { error: 'Sorry — this job offer has expired. Check your dashboard for new opportunities.' }, {
          reasonCode: 'offer_expired',
          stage: 'dispatch_offer_expired',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }

      // Verify booking still exists and is available
      const { data: booking } = await sb.from('bookings').select('*').eq('id', bookingId).single();
      if (!booking) {
        return rejectWithTelemetry(404, { error: 'Booking not found' }, {
          reasonCode: 'booking_not_found',
          stage: 'dispatch_offer_booking_lookup',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }
      if (booking.status !== BOOKING_STATUS.CONFIRMED) {
        return rejectWithTelemetry(400, { error: 'This booking is no longer available' }, {
          reasonCode: 'booking_not_confirmed',
          stage: 'dispatch_offer_booking_status',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }
      if (booking.assembler_id) {
        return rejectWithTelemetry(409, { error: 'Sorry — another Easer just accepted this job.' }, {
          reasonCode: 'booking_already_assigned',
          stage: 'dispatch_offer_booking_assigned',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }

      // Get Easer profile and enforce operational eligibility at accept time
      const { data: easer } = await sb.from('profiles').select('*').eq('id', assemblerId).single();
      if (!easer) {
        return rejectWithTelemetry(404, { error: 'Easer profile not found' }, {
          reasonCode: 'profile_not_found',
          stage: 'dispatch_offer_profile_lookup',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }
      {
        const eligibility = getEaserEligibility(easer);
        if (!eligibility.ok) {
          return rejectWithTelemetry(403, { error: eligibility.error }, {
            reasonCode: eligibility.error.includes('Identity verification') ? 'ineligible_identity' : 'ineligible_status',
            stage: 'dispatch_offer_eligibility',
            actorIdHash,
            bookingHash,
            offerHash,
          });
        }
      }

      // ── Atomic CAS: assign only if assembler_id is still null ─────────────
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
        return rejectWithTelemetry(409, { error: 'Sorry — another Easer accepted this job first.' }, {
          reasonCode: 'race_lost',
          stage: 'dispatch_offer_assign_cas',
          actorIdHash,
          bookingHash,
          offerHash,
        });
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
      await emitTerminalEvent('accept_dispatch_success', {
        statusCode: 200,
        reasonCode: null,
        reasonDetail: null,
        stage: 'dispatch_offer_success',
        mutationResult: 'accepted',
        actorIdHash,
        bookingHash,
        offerHash,
        payload: { path: 'dispatch_offers' },
      });
      return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
    }

    // ── Path 2: Legacy inline tokens (assignment_token or dispatch_token) ───
    const { data: booking, error: bErr } = await sb
      .from('bookings').select('*').eq('id', bookingId).single();

    if (bErr || !booking) {
      return rejectWithTelemetry(404, { error: 'Booking not found' }, {
        reasonCode: 'booking_not_found',
        stage: 'legacy_booking_lookup',
        actorIdHash,
        bookingHash,
        offerHash,
      });
    }
    if (booking.status !== BOOKING_STATUS.CONFIRMED) {
      return rejectWithTelemetry(400, { error: 'This booking is no longer available' }, {
        reasonCode: 'booking_not_confirmed',
        stage: 'legacy_booking_status',
        actorIdHash,
        bookingHash,
        offerHash,
      });
    }

    const isDispatch   = booking.dispatch_token && booking.dispatch_token === token;
    const isAssignment = booking.assignment_token && booking.assignment_token === token
                      && booking.assembler_id === assemblerId;

    if (!isDispatch && !isAssignment) {
      return rejectWithTelemetry(403, { error: 'Invalid or expired offer token' }, {
        reasonCode: 'legacy_token_invalid',
        stage: 'legacy_token_validation',
        actorIdHash,
        bookingHash,
        offerHash,
      });
    }

    if (isDispatch) {
      if (booking.assembler_id) {
        return rejectWithTelemetry(409, { error: 'Sorry — another Easer just accepted this job.' }, {
          reasonCode: 'booking_already_assigned',
          stage: 'legacy_dispatch_already_assigned',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }
      const offeredTo = booking.dispatch_offered_to || [];
      if (!offeredTo.includes(assemblerId)) {
        return rejectWithTelemetry(403, { error: 'This job offer was not sent to your account' }, {
          reasonCode: 'legacy_token_invalid',
          stage: 'legacy_dispatch_not_offered',
          actorIdHash,
          bookingHash,
          offerHash,
        });
      }
    }

    const { data: easer } = await sb.from('profiles').select('*').eq('id', assemblerId).single();
    if (!easer) {
      return rejectWithTelemetry(404, { error: 'Easer profile not found' }, {
        reasonCode: 'profile_not_found',
        stage: 'legacy_profile_lookup',
        actorIdHash,
        bookingHash,
        offerHash,
      });
    }
    {
      const eligibility = getEaserEligibility(easer);
      if (!eligibility.ok) {
        return rejectWithTelemetry(403, { error: eligibility.error }, {
          reasonCode: eligibility.error.includes('Identity verification') ? 'ineligible_identity' : 'ineligible_status',
          stage: 'legacy_eligibility',
          actorIdHash,
          bookingHash,
          offerHash,
        });
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

    if (assignErr) {
      return rejectWithTelemetry(409, { error: 'Sorry — another Easer accepted this job first' }, {
        reasonCode: 'race_lost',
        stage: 'legacy_assign_cas',
        actorIdHash,
        bookingHash,
        offerHash,
      });
    }

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
    await emitTerminalEvent('accept_dispatch_success', {
      statusCode: 200,
      reasonCode: null,
      reasonDetail: null,
      stage: 'legacy_success',
      mutationResult: 'accepted',
      actorIdHash,
      bookingHash,
      offerHash,
      payload: { path: isDispatch ? 'legacy_dispatch' : 'legacy_assignment' },
    });
    return res.status(200).json({ ok: true, message: 'Job accepted! It will appear in your My Assignments.', ref: booking.ref });
  } catch (error) {
    await emitTerminalEvent('accept_dispatch_runtime_error', {
      statusCode: 500,
      reasonCode: 'runtime_exception',
      reasonDetail: error?.message || 'Unexpected accept-dispatch exception',
      stage: 'runtime_exception',
      mutationResult: 'exception',
      payload: { name: error?.name || 'Error' },
    });
    throw error;
  }
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

  return { ok: true };
}
