import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { sendEmail, ownerEmail, esc } from '../_email.js';
import { dispatchBooking } from './_dispatch-internal.js';
import { logActivity } from './_activity.js';
import { adjustActiveJobs } from './_active-jobs.js';
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';

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

  const { data: easer } = await sb.from('profiles').select('full_name').eq('id', user.id).single();
  const easerName = easer?.full_name || 'A Pro';

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
  })
  .eq('id', bookingId)
  .eq('assembler_id', user.id)   // CAS: only the current owner can drop
  .eq('status', BOOKING_STATUS.CONFIRMED)
  .select('id');

  if (relErr || !releasedRows || releasedRows.length === 0) {
    return res.status(409).json({ error: 'Could not drop this job — it may have already changed. Refresh and try again.' });
  }

  // Cancel any lingering offer records so previously-offered Pros become eligible
  // again on the fresh dispatch (cancelled offers are not in the exclusion set).
  await sb.from('dispatch_offers')
    .update({ offer_status: DISPATCH_OFFER_STATUS.CANCELLED })
    .eq('booking_id', bookingId)
    .in('offer_status', [DISPATCH_OFFER_STATUS.SENT, DISPATCH_OFFER_STATUS.ACCEPTED, DISPATCH_OFFER_STATUS.SUPERSEDED]);

  // Drop within the grace window carries no penalty — that's the point of the
  // window. We do NOT set last_dispatch_declined_at. The dropper is simply
  // excluded from this one re-dispatch via excludeEaserId.
  adjustActiveJobs(sb, user.id, -1).catch(() => {});

  logActivity(sb, {
    bookingId,
    eventType: 'easer_dropped',
    actorType: 'easer',
    actorId: user.id,
    actorName: easerName,
    description: `${easerName} dropped the job within the ${DROP_WINDOW_MIN}-min window — re-dispatching to other Pros`,
    metadata: { elapsed_min: Math.round(elapsedMin), ref: booking.ref },
  });

  // ── Owner FYI (non-blocking). Customer is NOT notified — silent re-match. ──
  sendEmail({
    to:   ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Job Dropped & Re-dispatching — ${esc(booking.ref || bookingId)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h3 style="color:#f59e0b">Pro Dropped a Job (within 15-min window)</h3>
      <p><strong>${esc(easerName)}</strong> dropped booking <strong>${esc(booking.ref || '')}</strong> (${esc(booking.service || '')}) ${Math.round(elapsedMin)} min after accepting.</p>
      <p>The job has been returned to the pool and re-dispatched to other online Pros. The customer was not notified.</p>
      <p><a href="${SITE}/owner/" style="color:#00BFFF">View in owner dashboard</a></p>
    </div>`,
  }).catch(() => {});

  // ── Re-dispatch fresh to all OTHER online Pros ────────────────────────────
  dispatchBooking(bookingId, { excludeEaserId: user.id })
    .catch(e => console.error('drop-job: re-dispatch error', e && e.message));

  console.log(`drop-job: ${easerName} dropped ${booking.ref || bookingId} after ${Math.round(elapsedMin)}min — re-dispatching`);
  return res.status(200).json({ ok: true, message: 'Job dropped. It has been sent to other Pros.' });
}
