import { chicagoTodayIso, parseIsoCalendarDate } from './_appt-date.js';

export const BOOKING_WINDOW_DAYS = 30;
export const IMMEDIATE_AUTHORIZATION_DAYS = 6;
export const SCHEDULED_AUTHORIZATION_LEAD_DAYS = 5;

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
