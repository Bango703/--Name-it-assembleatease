import { BOOKING_STATUS } from '../_source-of-truth.js';
import { notificationAppointmentTimestampMs, notificationAppointmentWindowEndMs } from './_appt-date.js';

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
// gone when they accepted. A job still sitting at the old time is reported
// once, by appointmentNeedsNewTime, as needing a new time.
//
// Owner, 2026-11-09: an Easer who checked in at 9:12 for an 8-10 AM arrival
// window was flagged at 9:00. The customer was promised arrival inside the
// window, so nobody is late before it closes, and never sooner than the grace
// after the start (or after a mid-window acceptance).
function appointmentTimes(booking) {
  const appointmentMs = notificationAppointmentTimestampMs(booking);
  if (appointmentMs == null) return null;
  const windowEndMs = notificationAppointmentWindowEndMs(booking) ?? appointmentMs;
  return { appointmentMs, windowEndMs };
}

export function arrivalFollowUp(booking, nowMs = Date.now()) {
  if (!acceptedAndNotThere(booking) || booking.date < arrivalFollowUpLookbackDate(nowMs)) return null;

  const times = appointmentTimes(booking);
  if (!times) return null;
  const { appointmentMs, windowEndMs } = times;
  const accepted = acceptedMs(booking);
  // Accepted after the arrival window closed and not on the way: the job needs
  // a new time, not a chase.
  if (accepted != null && accepted >= windowEndMs && booking.status === BOOKING_STATUS.CONFIRMED) return null;
  const acceptedAfterStart = accepted != null && accepted > appointmentMs;
  const startMs = acceptedAfterStart ? accepted : appointmentMs;
  const dueMs = Math.max(windowEndMs, startMs + GRACE_MINUTES * 60000);
  if (nowMs < dueMs) return null;
  return { appointmentMs, minutesLate: Math.round((nowMs - startMs) / 60000), measuredFrom: acceptedAfterStart ? 'acceptance' : 'appointment' };
}

// The current Easer accepted after the arrival window closed, the job has not
// moved to a new time, and nobody is on the way. Not lateness: it needs a time.
export function appointmentNeedsNewTime(booking, nowMs = Date.now()) {
  if (!acceptedAndNotThere(booking) || booking.status !== BOOKING_STATUS.CONFIRMED) return null;
  const times = appointmentTimes(booking);
  const accepted = acceptedMs(booking);
  if (!times || accepted == null || accepted < times.windowEndMs || nowMs < times.windowEndMs) return null;
  return { appointmentMs: times.appointmentMs };
}
