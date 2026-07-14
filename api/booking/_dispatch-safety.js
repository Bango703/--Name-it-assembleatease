import { sendEmail, ownerEmail, esc } from '../_email.js';
import { DISPATCH_OFFER_STATUS } from '../_source-of-truth.js';
import { logActivity } from './_activity.js';

const DEFAULT_ASSIGNMENT_TOKEN_TTL_MIN = 24 * 60;

// A terminal response to this booking should not receive another automatic
// offer for the same job. This also prevents a cancelled stale offer from
// reappearing after an owner action or a competing acceptance.
export const DISPATCH_HISTORY_EXCLUSION_STATUSES = Object.freeze([
  DISPATCH_OFFER_STATUS.SENT,
  DISPATCH_OFFER_STATUS.ACCEPTED,
  DISPATCH_OFFER_STATUS.DECLINED,
  DISPATCH_OFFER_STATUS.EXPIRED,
  DISPATCH_OFFER_STATUS.CANCELLED,
  DISPATCH_OFFER_STATUS.SUPERSEDED,
]);

export function legacyAssignmentTokenTtlMinutes() {
  const configured = Number.parseInt(process.env.LEGACY_ASSIGNMENT_TOKEN_TTL_MINUTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_ASSIGNMENT_TOKEN_TTL_MIN;
}

export function isLegacyAssignmentTokenFresh(booking, {
  nowMs = Date.now(),
  ttlMinutes = legacyAssignmentTokenTtlMinutes(),
} = {}) {
  const issuedAt = Date.parse(booking?.assigned_at || '');
  if (!Number.isFinite(issuedAt)) return false;
  const ttlMs = Math.max(1, Number(ttlMinutes) || DEFAULT_ASSIGNMENT_TOKEN_TTL_MIN) * 60 * 1000;
  return nowMs >= issuedAt && (nowMs - issuedAt) < ttlMs;
}

export async function finalizeDispatchRound(sb, {
  bookingId,
  maxAttempts,
  forceManual = false,
}) {
  const { data, error } = await sb.rpc('finalize_dispatch_round', {
    p_booking_id: bookingId,
    p_max_attempts: maxAttempts,
    p_force_manual: forceManual,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    action: row?.result_action || 'unknown',
    ref: row?.result_ref || null,
    attempt: Number(row?.result_attempt || 0),
  };
}

export async function declineDispatchOffer(sb, {
  offerId,
  bookingId,
  easerId,
  reason,
  declinedAt,
  maxAttempts,
}) {
  const { data, error } = await sb.rpc('decline_dispatch_offer', {
    p_offer_id: offerId,
    p_booking_id: bookingId,
    p_easer_id: easerId,
    p_decline_reason: reason || 'no_reason',
    p_declined_at: declinedAt,
    p_max_attempts: maxAttempts,
  });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    action: row?.result_action || 'unknown',
    ref: row?.result_ref || null,
    attempt: Number(row?.result_attempt || 0),
  };
}

export async function notifyOwnerManualDispatch(sb, {
  booking,
  reason,
  source,
  metadata = null,
}) {
  const bookingId = booking?.id || null;
  const ref = booking?.ref || bookingId || 'Unknown booking';
  const detail = reason || 'Automatic dispatch could not safely continue.';

  // finalize_dispatch_round writes dispatch_manual_required to the owner
  // timeline in the same transaction that flips the booking flags. This helper
  // handles the external alert only, so the timeline never gets duplicates.
  const activity = { ok: true, persistedBy: 'finalize_dispatch_round' };

  const email = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Action Required: ${esc(ref)} needs manual assignment`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#dc2626">Job Needs Manual Assignment</h2>
      <p><strong>${esc(ref)}</strong>${booking?.service ? ` — ${esc(booking.service)}` : ''}</p>
      <p>${esc(detail)}</p>
      <p>The booking is flagged and automatic dispatch is paused. Review it before assigning an Easer manually.</p>
      <p><a href="https://www.assembleatease.com/owner/#bookings" style="color:#00BFFF;font-weight:600">Open Owner Dashboard</a></p>
    </div>`,
    meta: {
      bookingId,
      notificationType: 'dispatch_manual_required',
      recipientType: 'owner',
      disableDedupe: false,
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  if (!email?.ok) {
    await logActivity(sb, {
      bookingId,
      eventType: 'dispatch_manual_alert_failed',
      actorType: 'system',
      actorName: 'notifications',
      description: `${ref} was flagged for manual dispatch, but the owner email failed`,
      metadata: { error: email?.error || null, source: source || null },
    });
  }

  return { activity, email };
}

export async function holdDispatchForPaymentReconciliation(sb, {
  booking,
  source,
  detail,
}) {
  const bookingId = booking?.id;
  if (!bookingId) throw new Error('Booking id is required for a payment dispatch hold');
  const ref = booking?.ref || bookingId;
  const { data: heldRows, error: holdError } = await sb.from('bookings').update({
    dispatch_paused: true,
    needs_manual_dispatch: false,
    dispatch_status: 'payment_hold',
  })
    .eq('id', bookingId)
    .eq('status', 'confirmed')
    .select('id');
  if (holdError || !heldRows?.length) {
    throw holdError || new Error('Booking changed before its payment hold was recorded');
  }

  await logActivity(sb, {
    bookingId,
    eventType: 'dispatch_payment_hold',
    actorType: 'system',
    actorName: source || 'dispatch',
    description: `${ref} was removed from dispatch until Stripe payment state is reconciled`,
    metadata: { source: source || null, detail: detail || null },
  });

  const email = await sendEmail({
    to: ownerEmail(),
    from: 'AssembleAtEase <booking@assembleatease.com>',
    subject: `Payment Reconciliation Required: ${esc(ref)}`,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
      <h2 style="color:#dc2626">Dispatch Paused for Payment Review</h2>
      <p><strong>${esc(ref)}</strong>${booking?.service ? ` - ${esc(booking.service)}` : ''}</p>
      <p>${esc(detail || 'Payment is not verified for dispatch.')}</p>
      <p>Do not assign an Easer or create another customer payment. Open the booking timeline and reconcile the linked Stripe PaymentIntent first.</p>
      <p><a href="https://www.assembleatease.com/owner/#bookings" style="color:#00BFFF;font-weight:600">Open Owner Dashboard</a></p>
    </div>`,
    meta: {
      bookingId,
      notificationType: 'dispatch_payment_hold',
      recipientType: 'owner',
    },
  }).catch(error => ({ ok: false, error: error?.message || String(error) }));

  return { held: true, email };
}
