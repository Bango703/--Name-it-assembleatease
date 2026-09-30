import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, EASER_RELIABILITY_POLICY, classifyEaserCancellation } from '../_source-of-truth.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { loadEaserStrikeSummary, recordEaserCancellation, pauseEaserIfOverLimit } from '../_easer-reliability.js';
import { finalizeDispatchRound, holdDispatchForPaymentReconciliation, notifyOwnerManualDispatch } from './_dispatch-safety.js';

const SITE = 'https://www.assembleatease.com';

// A Pro may cancel a job they accepted. Inside the grace window it is free;
// after it, the cancellation is self-service (the job goes straight back out,
// no owner case to wait on) and it carries reliability strikes set by
// EASER_RELIABILITY_POLICY: late (<24h) 1, same-day 2, pause at 3 in 90 days.
const DROP_WINDOW_MIN = EASER_RELIABILITY_POLICY.graceMinutes;
const DROP_REASONS = new Set(['Emergency', 'Vehicle issue', 'Running too late', 'Schedule conflict', 'Other']);

/**
 * POST /api/booking/drop-job
 * Easer drops (cancels) a job they accepted, within the 15-minute grace window.
 * Requires Easer JWT — the assembler is taken from the verified token.
 * Body: { bookingId, reason?, note? }
 *
 * On success: the booking is unassigned, returned to the pool, and re-dispatched
 * fresh to all other online Pros (the dropper is excluded from that re-offer).
 * The customer is NOT alarmed — their tracking page simply shows it re-matching.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { bookingId, reason: rawReason, note: rawNote, preview } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });
  const reason = String(rawReason || '').trim();
  const note = String(rawNote || '').trim();
  if (reason && !DROP_REASONS.has(reason)) return res.status(400).json({ error: 'Choose a valid drop reason' });
  if (note.length > 1200) return res.status(400).json({ error: 'Additional details must be 1,200 characters or fewer' });

  const sb = getSupabase();
  const now = new Date();
  const nowIso = now.toISOString();

  // ── Load booking and verify this Pro owns it ──────────────────────────────
  const { data: booking, error: bErr } = await sb
    .from('bookings').select('*').eq('id', bookingId).single();
  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });

  if (booking.assembler_id !== user.id) {
    return res.status(403).json({ error: 'This job is not assigned to you.' });
  }

  // Only a confirmed-but-not-started job can be self-dropped. Once the Pro is
  // en route or on site, dropping must go through support.
  if (booking.status !== BOOKING_STATUS.CONFIRMED) {
    return res.status(409).json({ error: 'This job is already in progress — please contact support to be released.' });
  }
  if (booking.source === 'owner_manual' && booking.payment_status === 'offline_recorded') {
    return res.status(409).json({
      error: 'This job cannot be dropped from the Easer app. Contact support if the assignment must change.',
      code: 'OWNER_MANUAL_REDISPATCH_BLOCKED',
    });
  }
  if (booking.financial_operation_key) {
    return res.status(409).json({ error: 'This job is temporarily unavailable. Refresh or contact support before dropping it.' });
  }

  if (!booking.assembler_accepted_at) {
    // No acceptance timestamp (e.g. owner-assigned) — no self-drop, support only.
    return res.status(403).json({ error: 'Please contact support to be released from this job.' });
  }
  const elapsedMin = (now.getTime() - new Date(booking.assembler_accepted_at).getTime()) / 60000;

  // ── Reliability: what this cancellation costs, decided by the one rule ────
  let appointmentMs = null;
  try { appointmentMs = appointmentTimestampMs(booking.date, booking.time); } catch (_) { appointmentMs = null; }
  const classification = classifyEaserCancellation({
    acceptedAtMs: new Date(booking.assembler_accepted_at).getTime(),
    nowMs: now.getTime(),
    appointmentMs,
    appointmentDate: booking.date || null,
  });
  let strikeSummary;
  try {
    strikeSummary = await loadEaserStrikeSummary(sb, user.id, { nowMs: now.getTime() });
  } catch (summaryError) {
    console.error('drop-job reliability read error:', summaryError);
    return res.status(503).json({ error: 'Your reliability record could not be checked. The job was not released. Try again in a moment.' });
  }
  const strikesAfter = strikeSummary.strikes + classification.strikes;
  const willPause = classification.strikes > 0 && strikesAfter >= EASER_RELIABILITY_POLICY.pauseAtStrikes;
  const impact = {
    kind: classification.kind,
    strikesAdded: classification.strikes,
    strikesBefore: strikeSummary.strikes,
    strikesAfter,
    pauseAtStrikes: EASER_RELIABILITY_POLICY.pauseAtStrikes,
    windowDays: EASER_RELIABILITY_POLICY.windowDays,
    willPause,
  };
  if (preview === true) {
    return res.status(200).json({ ok: true, preview: true, impact });
  }

  // Account status/closure intentionally does not block releasing owned work,
  // but the authenticated user must still hold the Easer role.
  const { data: easerProfile, error: easerProfileError } = await sb
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .maybeSingle();
  if (easerProfileError) {
    console.error('drop-job Easer role lookup error:', easerProfileError);
    return res.status(503).json({ error: 'Easer role could not be verified. The job was not released.' });
  }
  if (!easerProfile || easerProfile.role !== 'assembler') {
    return res.status(403).json({ error: 'An Easer account is required to release an assigned job.' });
  }
  const easerName = easerProfile.full_name || 'A Pro';

  // ── Release the job (atomic CAS on assembler_id) ──────────────────────────
  // Reset dispatch counters so it re-dispatches as a brand-new job (not counting
  // against the prior MAX_ATTEMPTS) and clears any prior offer fan-out.
  const { data: releasedRows, error: relErr } = await sb.from('bookings').update({
    assembler_id:          null,
    assembler_name:        null,
    assembler_tier:        null,
    assembler_accepted_at: null,
    assigned_at:           null,
    dispatch_status:       'dropped',
    dispatch_attempt:      0,
    dispatch_offered_to:   [],
    dispatch_offered_at:   null,
    needs_manual_dispatch: false,
    dispatch_paused:       false,
    dispatch_token:        null,
    assignment_token:      null,
    easer_fee_snapshot_easer_id: null,
    easer_fee_pct_snapshot: null,
    easer_estimated_due_snapshot: null,
    easer_fee_snapshot_at: null,
  })
  .eq('id', bookingId)
  .eq('assembler_id', user.id)   // CAS: only the current owner can drop
  .eq('status', BOOKING_STATUS.CONFIRMED)
  .is('financial_operation_key', null)
  .select('id');

  if (relErr || !releasedRows || releasedRows.length === 0) {
    return res.status(409).json({ error: 'Could not drop this job — it may have already changed. Refresh and try again.' });
  }

  // Terminalize lingering offer records. Their history stays excluded so an
  // Easer does not receive the same job again after already responding to it.
  const { error: offerCleanupError } = await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', bookingId)
    .in('offer_status', [DISPATCH_OFFER_STATUS.SENT, DISPATCH_OFFER_STATUS.ACCEPTED, DISPATCH_OFFER_STATUS.SUPERSEDED]);

  // Drop within the grace window carries no penalty — that's the point of the
  // window. We do NOT set last_dispatch_declined_at. The dropper is simply
  // excluded from this one re-dispatch via excludeEaserId.
  adjustActiveJobs(sb, user.id, -1).catch(() => {});

  // The strike is recorded and checked, then the pause applied if it reaches the limit.
  const strikeRecord = await recordEaserCancellation(sb, {
    booking, easerId: user.id, easerName, classification, reason: reason || null, note: note || null,
  });
  if (!strikeRecord.ok) console.error('drop-job: reliability strike not recorded', strikeRecord.error);
  const pause = strikeRecord.ok
    ? await pauseEaserIfOverLimit(sb, { easerId: user.id, easerName, strikes: strikesAfter, bookingId })
    : { paused: false };

  await logActivity(sb, {
    bookingId,
    eventType: 'easer_dropped',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: classification.kind === 'grace'
      ? `${easerName} dropped the job within the ${DROP_WINDOW_MIN}-min window — re-dispatching to other Pros`
      : `${easerName} cancelled the job (${classification.kind.replace('_', '-')}, ${classification.strikes} strike${classification.strikes === 1 ? '' : 's'}) — re-dispatching to other Pros`,
    metadata: {
      elapsed_min: Math.round(elapsedMin),
      ref: booking.ref,
      reason: reason || null,
      note: note || null,
    },
  });

  // ── Re-dispatch fresh to all OTHER online Pros ────────────────────────────
  // Do not return until the platform knows whether offers were actually made.
  // A failed/no-candidate redispatch is atomically converted to owner action.
  let redispatch = null;
  let finalization = null;
  let redispatchError = offerCleanupError || null;

  if (!offerCleanupError) {
    try {
      redispatch = await dispatchBooking(bookingId, { excludeEaserId: user.id });
    } catch (error) {
      redispatchError = error;
    }
  }

  if (redispatch?.code === 'DISPATCH_PAYMENT_NOT_VERIFIED') {
    try {
      await holdDispatchForPaymentReconciliation(sb, {
        booking,
        source: 'drop-job',
        detail: redispatch.message,
      });
      finalization = { action: 'payment_hold' };
    } catch (holdError) {
      redispatchError = holdError;
    }
  }

  if (redispatchError || (!redispatch?.dispatched && redispatch?.code !== 'DISPATCH_PAYMENT_NOT_VERIFIED')) {
    try {
      finalization = await finalizeDispatchRound(sb, {
        bookingId,
        maxAttempts: parseInt(process.env.DISPATCH_MAX_ATTEMPTS || '3', 10),
        forceManual: true,
      });
      if (finalization.action === 'manual_required') {
        await notifyOwnerManualDispatch(sb, {
          booking,
          source: 'drop-job',
          reason: redispatchError
            ? `The Easer released the job, but redispatch failed (${redispatchError.message || String(redispatchError)}).`
            : `The Easer released the job, but no new offers were created (${redispatch?.message || 'no eligible Easer'}).`,
          metadata: { droppedBy: user.id, redispatch, offerCleanupFailed: Boolean(offerCleanupError) },
        });
      }
    } catch (finalizeError) {
      console.error('drop-job: manual-dispatch finalization failed', finalizeError);
      await logActivity(sb, {
        bookingId,
        eventType: 'dispatch_finalization_failed',
        actorType: 'system',
        actorName: 'drop-job',
        description: `${booking.ref || bookingId} was dropped, but redispatch and manual finalization failed`,
        metadata: {
          redispatchError: redispatchError?.message || null,
          finalizationError: finalizeError?.message || String(finalizeError),
        },
      });
    }
  }

  const offersCreated = Number(redispatch?.dispatched || 0) > 0;
  const safelyRematching = offersCreated || finalization?.action === 'open_offers';
  const manualRequired = finalization?.action === 'manual_required' || finalization?.action === 'already_manual';
  const paymentHeld = finalization?.action === 'payment_hold';

  // ── Owner FYI. Customer is not notified — their booking remains confirmed. ──
  if ((!manualRequired && !paymentHeld) || pause.paused || classification.strikes > 0) {
    await sendEmail({
      to:   ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `${classification.kind === 'same_day' ? 'Same-day Easer cancellation' : classification.kind === 'late' ? 'Late Easer cancellation' : 'Job Dropped'} — ${esc(booking.ref || bookingId)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h3 style="color:#f59e0b">${classification.kind === 'grace' ? 'Easer dropped a job within 15 minutes of accepting' : 'Easer cancelled an accepted job'}</h3>
        <p><strong>Reliability:</strong> ${classification.strikes} strike${classification.strikes === 1 ? '' : 's'} for ${({ late: 'a late cancellation (under 24 hours)', same_day: 'a same-day cancellation', grace: 'a cancellation within 15 minutes of accepting', advance: 'a cancellation with 24+ hours notice' }[classification.kind] || 'a cancellation')}. ${esc(easerName)} now has ${strikesAfter} in the last ${EASER_RELIABILITY_POLICY.windowDays} days; new jobs pause at ${EASER_RELIABILITY_POLICY.pauseAtStrikes}.${pause.paused ? ' <strong>New jobs are now paused for this Easer. You can reactivate them from the Easers page.</strong>' : ''}${strikeRecord.ok ? '' : ' <strong>The strike could not be saved; check the booking timeline.</strong>'} For a genuine emergency, you can excuse it from the Easer's profile.</p>
        <p><strong>${esc(easerName)}</strong> dropped booking <strong>${esc(booking.ref || '')}</strong> (${esc(booking.service || '')}) ${Math.round(elapsedMin)} min after accepting.</p>
        ${reason ? `<p><strong>Reason:</strong> ${esc(reason)}${note ? `<br/><strong>Additional details:</strong> ${esc(note)}` : ''}</p>` : ''}
        <p>${safelyRematching ? 'The job is being offered to other Easers.' : 'No other Easer could be offered the job automatically; assign it from the dashboard.'} The customer was not notified.</p>
        <p><a href="${SITE}/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
      </div>`,
      meta: { bookingId, notificationType: 'job_dropped', recipientType: 'owner' },
    }).catch(() => {});
  }

  console.log(`drop-job: ${easerName} dropped ${booking.ref || bookingId} after ${Math.round(elapsedMin)}min`, {
    redispatch,
    finalization,
    redispatchError: redispatchError?.message || null,
  });

  const strikeText = classification.strikes > 0
    ? ` This counts as ${classification.strikes} reliability strike${classification.strikes === 1 ? '' : 's'}; you now have ${strikesAfter} in the last ${EASER_RELIABILITY_POLICY.windowDays} days.`
    : '';
  return res.status(200).json({
    ok: true,
    impact: { ...impact, paused: pause.paused === true },
    message: pause.paused
      ? `Job cancelled.${strikeText} You have reached ${EASER_RELIABILITY_POLICY.pauseAtStrikes} strikes, so new jobs are paused until AssembleAtEase reviews your account.`
      : `Job cancelled. You will not receive further updates for this job.${strikeText}`,
  });
}
