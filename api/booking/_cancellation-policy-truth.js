import { computeCancellationFee } from '../_source-of-truth.js';
import { appointmentTimestampMs } from './_appt-date.js';
import { cancellationPolicyEvaluationTimeMs } from './_cancellation-operation.js';

export function loadBookingRescheduleTruth(booking) {
  if (!booking?.id) {
    const error = new Error('Booking reschedule truth input is incomplete.');
    error.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw error;
  }
  const rescheduleCount = Number(booking.reschedule_count);
  if (!Number.isInteger(rescheduleCount) || rescheduleCount < 0) {
    // Same false cause as the other three: 037 is applied, and a null
    // reschedule_count on an older booking is a per-booking gap, not a
    // missing migration.
    const truthError = new Error('This booking has no reschedule history recorded, so the cancellation policy cannot be applied safely. Reconcile it before taking a payment action.');
    truthError.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw truthError;
  }
  return { wasRescheduled: rescheduleCount > 0, rescheduleCount };
}


// The ONE place a booking's cancellation outcome is worked out. The customer
// cancel, the guest cancel and the tracking-page preview all call this, so
// the fee a customer is shown is the fee they are charged, with the same
// reason (AAE-TYRHONCHIO: the tracking page ran its own copy of the policy
// without the no-Easer rule). Throws CANCELLATION_POLICY_TRUTH_UNAVAILABLE
// when the reschedule history is missing, as before.
// Options used only by the owner cancel: `isNoShow` (owner flags a customer
// no-show) and `allowMissingRescheduleTruth` (a waived fee does not need the
// reschedule history; it is treated as not rescheduled).
export function evaluateCancellationPolicy(booking, { nowMs, isNoShow = false, allowMissingRescheduleTruth = false } = {}) {
  const evaluationMs = Number.isFinite(nowMs) ? nowMs : cancellationPolicyEvaluationTimeMs(booking);
  let hoursAway = null;
  try {
    const apptMs = appointmentTimestampMs(booking.date, booking.time);
    if (apptMs != null) hoursAway = (apptMs - evaluationMs) / 3600000;
  } catch (e) { console.error('Date parse error:', e); }

  // A rescheduled booking forfeits its free window (disclosed at reschedule time).
  let wasRescheduled = false;
  try {
    ({ wasRescheduled } = loadBookingRescheduleTruth(booking));
  } catch (policyTruthError) {
    if (!allowMissingRescheduleTruth) throw policyTruthError;
  }

  const serviceSubtotalCents = Math.max(0,
    (booking.total_price || 0) - (booking.tax_amount || 0) - (booking.service_call_fee || 0));
  const policy = computeCancellationFee({
    serviceSubtotalCents,
    hoursUntilAppointment: hoursAway,
    status: booking.status,
    isNoShow,
    forfeitFreeWindow: wasRescheduled,
    // No accepted Easer means no commitment to compensate. The rule lives in
    // computeCancellationFee; this only supplies the fact it needs.
    easerAccepted: Boolean(booking.assembler_id && booking.assembler_accepted_at),
  });
  return { policy, hoursAway, wasRescheduled };
}
