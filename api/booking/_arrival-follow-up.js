import { BOOKING_STATUS } from '../_source-of-truth.js';
import { notificationAppointmentTimestampMs } from './_appt-date.js';

// Shared by the existing owner notification and Live Ops. This reports missing
// arrival evidence, never a conclusion that an Easer physically failed to show.
const GRACE_MINUTES = 60;
const LOOKBACK_DAYS = 3;

export function arrivalFollowUpLookbackDate(nowMs = Date.now()) {
  return new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
}

function acceptedAndNotThere(booking) {
  return Boolean(booking?.assembler_id && booking.assembler_accepted_at && booking.date)
    && [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE].includes(booking.status)
    && !booking.checked_in_at && booking.return_visit_required !== true;
}

// When the current Easer accepted, or null when the stored time cannot be read.
function acceptedMs(booking) {
  const ms = Date.parse(booking.assembler_accepted_at);
  return Number.isFinite(ms) ? ms : null;
}

// Owner, 2026-11-08: a job reassigned after a no-show alerted "possible no-show"
// against the new Easer, measured from the old appointment that had passed
// before they ever took the job. Nobody can be late for a time that was already
// gone when they accepted, so lateness is measured from whichever came later:
// the appointment start or the acceptance. A job still sitting at the old time
// is reported once, by appointmentNeedsNewTime, as needing a new time.
export function arrivalFollowUp(booking, nowMs = Date.now()) {
  if (!acceptedAndNotThere(booking) || booking.date < arrivalFollowUpLookbackDate(nowMs)) return null;

  const appointmentMs = notificationAppointmentTimestampMs(booking);
  if (appointmentMs == null) return null;
  const accepted = acceptedMs(booking);
  const lateAccept = accepted != null && accepted >= appointmentMs;
  // Accepted late and not on the way: the job needs a new time, not a chase.
  if (lateAccept && booking.status === BOOKING_STATUS.CONFIRMED) return null;
  const startMs = lateAccept ? accepted : appointmentMs;
  if (nowMs < startMs + GRACE_MINUTES * 60000) return null;
  return { appointmentMs, minutesLate: Math.round((nowMs - startMs) / 60000), measuredFrom: lateAccept ? 'acceptance' : 'appointment' };
}

// The current Easer accepted after the appointment had started, the job has not
// moved to a new time, and nobody is on the way. Not lateness: it needs a time.
export function appointmentNeedsNewTime(booking, nowMs = Date.now()) {
  if (!acceptedAndNotThere(booking) || booking.status !== BOOKING_STATUS.CONFIRMED) return null;
  const appointmentMs = notificationAppointmentTimestampMs(booking);
  const accepted = acceptedMs(booking);
  if (appointmentMs == null || accepted == null || accepted < appointmentMs || nowMs < appointmentMs) return null;
  return { appointmentMs };
}
