import { BOOKING_STATUS } from '../_source-of-truth.js';
import { notificationAppointmentTimestampMs } from './_appt-date.js';

// Shared by the existing owner notification and Live Ops. This reports missing
// arrival evidence, never a conclusion that an Easer physically failed to show.
const GRACE_MINUTES = 60;
const LOOKBACK_DAYS = 3;

export function arrivalFollowUpLookbackDate(nowMs = Date.now()) {
  return new Date(nowMs - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
}

export function arrivalFollowUp(booking, nowMs = Date.now()) {
  if (!booking?.assembler_id || !booking.assembler_accepted_at
      || ![BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE].includes(booking.status)
      || booking.checked_in_at || booking.return_visit_required === true
      || !booking.date || booking.date < arrivalFollowUpLookbackDate(nowMs)) return null;

  const appointmentMs = notificationAppointmentTimestampMs(booking);
  if (appointmentMs == null || nowMs < appointmentMs + GRACE_MINUTES * 60000) return null;
  return { appointmentMs, minutesLate: Math.round((nowMs - appointmentMs) / 60000) };
}
