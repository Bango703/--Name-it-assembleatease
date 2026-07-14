import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { finalizeDispatchRound, holdDispatchForPaymentReconciliation, notifyOwnerManualDispatch } from './_dispatch-safety.js';

const SITE = 'https://www.assembleatease.com';

// A Pro may self-cancel a job they accepted, but only within this grace window
// after acceptance. After it closes, they must contact support to be released —
// this is the anti-flake commitment rule.
const DROP_WINDOW_MIN = parseInt(process.env.EASER_DROP_WINDOW_MINUTES || '15', 10);

/**
 * POST /api/booking/drop-job
 * Easer drops (cancels) a job they accepted, within the 15-minute grace window.
 * Requires Easer JWT — the assembler is taken from the verified token.
 * Body: { bookingId }
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

  const { bookingId } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

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
  if (booking.financial_operation_key) {
    return res.status(409).json({ error: 'This job is temporarily locked while a financial operation finishes. Contact support before dropping it.' });
  }

  // ── 15-minute window check (from acceptance) ──────────────────────────────
  if (!booking.assembler_accepted_at) {
    // No acceptance timestamp (e.g. owner-assigned) — no self-drop, support only.
    return res.status(403).json({ error: 'Please contact support to be released from this job.' });
  }
  const elapsedMin = (now.getTime() - new Date(booking.assembler_accepted_at).getTime()) / 60000;
  if (elapsedMin > DROP_WINDOW_MIN) {
    return res.status(403).json({
      error: `The ${DROP_WINDOW_MIN}-minute window to drop this job has passed. Please contact support to be released.`,
      windowClosed: true,
    });
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

  await logActivity(sb, {
    bookingId,
    eventType: 'easer_dropped',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: `${easerName} dropped the job within the ${DROP_WINDOW_MIN}-min window — re-dispatching to other Pros`,
    metadata: { elapsed_min: Math.round(elapsedMin), ref: booking.ref },
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
  if (!manualRequired && !paymentHeld) {
    await sendEmail({
      to:   ownerEmail(),
      from: 'AssembleAtEase <booking@assembleatease.com>',
      subject: `Job Dropped — ${esc(booking.ref || bookingId)}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
        <h3 style="color:#f59e0b">Pro Dropped a Job (within 15-min window)</h3>
        <p><strong>${esc(easerName)}</strong> dropped booking <strong>${esc(booking.ref || '')}</strong> (${esc(booking.service || '')}) ${Math.round(elapsedMin)} min after accepting.</p>
        <p>${safelyRematching ? 'The job is being matched to other online Pros.' : 'Automatic redispatch needs owner review.'} The customer was not notified.</p>
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

  return res.status(200).json({
    ok: true,
    message: offersCreated
      ? 'Job dropped. It has been sent to other Pros.'
      : paymentHeld
        ? 'Job dropped. Dispatch is paused while the owner reconciles customer payment.'
      : manualRequired
        ? 'Job dropped. The owner has been alerted to reassign it manually.'
        : 'Job dropped. Rematching is being reviewed.',
    redispatch,
    dispatchAction: finalization?.action || (offersCreated ? 'offers_created' : 'review_required'),
    warning: (!offersCreated && !manualRequired)
      ? 'The job was released, but rematching needs owner review.'
      : null,
  });
}
