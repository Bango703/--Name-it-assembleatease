import { appointmentTimestampMs, chicagoTodayIso } from './_appt-date.js';
import { sameDayFeeForAppointment, SAME_DAY_MIN_LEAD_MINUTES } from '../_source-of-truth.js';

/**
 * The appointment windows a new booking may choose, written exactly as
 * api/booking.js stores and accepts them (en dash). Reschedules use the hyphen
 * form in reschedule.js TIME_SLOTS and normalize, so the two lists differ only
 * in the dash. scripts/test-customer-native-app.mjs fails if this list and the
 * allowedSlots check inside api/booking.js ever disagree.
 */
export const BOOKING_TIME_SLOTS = Object.freeze([
  '8:00 AM – 10:00 AM', '10:00 AM – 12:00 PM', '12:00 PM – 2:00 PM',
  '2:00 PM – 4:00 PM', '4:00 PM – 6:00 PM', '6:00 PM – 8:00 PM',
]);

/**
 * The windows still open on a date: the same two gates api/booking.js applies
 * after the slot list (the start has not passed; same-day bookings keep the
 * same-day lead time).
 */
export function openBookingSlots(date, now = new Date()) {
  const nowMs = now.getTime();
  const sameDay = sameDayFeeForAppointment(date, now) > 0;
  return BOOKING_TIME_SLOTS.filter((slot) => {
    const startMs = appointmentTimestampMs(date, slot);
    if (startMs == null || startMs <= nowMs) return false;
    return !sameDay || (startMs - nowMs) >= SAME_DAY_MIN_LEAD_MINUTES * 60000;
  });
}

export function todayOpenBookingSlots(now = new Date()) {
  const today = chicagoTodayIso(now);
  return { today, slots: openBookingSlots(today, now) };
}
