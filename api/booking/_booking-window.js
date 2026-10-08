import { chicagoTodayIso, parseIsoCalendarDate } from './_appt-date.js';

export const BOOKING_WINDOW_DAYS = 30;

/**
 * How early a card hold may be taken. Both numbers together are bounded by the
 * SHORTEST authorization window any card network gives us.
 *
 * Stripe's windows:
 *   Visa merchant-initiated ... 4 days 18 hours (114h)  <- the floor
 *   Visa customer-initiated ... 7 days
 *   Mastercard / Amex / Disc .. 7 days
 *
 * At 6 and 5 both were longer than that floor, so a Visa hold could die before
 * its own appointment. AAE-DVSNHXE4OO was booked Sep 19 for Sep 24 — five days
 * out, inside IMMEDIATE_AUTHORIZATION_DAYS — authorized on the spot, and dead
 * on the 23rd. The Easer worked the 24th and capture failed on a finished job.
 *
 * The two must stay EQUAL. IMMEDIATE decides what skips the cron altogether
 * (see needsScheduledAuthorization), so any value above the scheduled lead
 * re-opens the same hole for bookings taken inside that gap — which is exactly
 * how the incident above bypassed the scheduled path.
 *
 * Two days, not three. Worst case — a long job, the completion buffer, and a
 * late appointment authorized at the previous morning's cron — three days
 * needs 109 of the 114 hours available and leaves five. Two leaves twenty-nine,
 * and still surfaces a dead card about forty-eight hours before an Easer
 * travels. scripts/test-authorization-lead-time.mjs holds the arithmetic and
 * fails with the exact shortfall if either number rises.
 */
export const IMMEDIATE_AUTHORIZATION_DAYS = 2;
export const SCHEDULED_AUTHORIZATION_LEAD_DAYS = 2;

export function addIsoDays(isoDate, days) {
  const parsed = parseIsoCalendarDate(isoDate);
  if (!parsed || !Number.isInteger(days)) return null;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function bookingWindow(now = new Date()) {
  const firstDate = chicagoTodayIso(now);
  return {
    firstDate,
    lastDate: addIsoDays(firstDate, BOOKING_WINDOW_DAYS),
    immediateAuthorizationLastDate: addIsoDays(firstDate, IMMEDIATE_AUTHORIZATION_DAYS),
  };
}

export function validateBookingWindowDate(date, now = new Date()) {
  const requestedDate = parseIsoCalendarDate(date);
  const window = bookingWindow(now);
  if (!requestedDate) return { ok: false, code: 'INVALID_APPOINTMENT_DATE', ...window };
  const requestedIso = requestedDate.toISOString().slice(0, 10);
  return {
    ok: requestedIso >= window.firstDate && requestedIso <= window.lastDate,
    code: requestedIso < window.firstDate ? 'APPOINTMENT_IN_PAST' : 'BOOKING_WINDOW_RESTRICTED',
    requestedDate,
    requestedIso,
    ...window,
  };
}

export function needsScheduledAuthorization(date, now = new Date()) {
  const result = validateBookingWindowDate(date, now);
  return result.ok && result.requestedIso > result.immediateAuthorizationLastDate;
}

export function scheduledAuthorizationDate(date) {
  return addIsoDays(date, -SCHEDULED_AUTHORIZATION_LEAD_DAYS);
}
