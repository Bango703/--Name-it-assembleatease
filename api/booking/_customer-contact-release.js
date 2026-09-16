import { appointmentTimestampMs } from './_appt-date.js';
import { BOOKING_STATUS, ACTIVE_BOOKING_STATUSES } from '../_source-of-truth.js';

// ─── Customer contact release ────────────────────────────────────────────────
//
// An Easer gets the customer's NAME, ADDRESS, and JOB DETAILS the moment they
// accept — they need those to plan the route and understand the work. Their
// PHONE and EMAIL are held back until shortly before the appointment.
//
// WHY 24 HOURS, and not a number someone liked the sound of:
//
// CANCELLATION_POLICY.freeWindowHours is 24. Up to that mark a customer can
// cancel for $0. That is precisely the window in which an off-platform side
// deal costs the customer nothing to take: the pro calls days ahead, offers
// cash, the customer cancels free, and the platform loses the job it sourced,
// the fee, and the customer. Releasing contact exactly when the free exit
// closes means that by the time a pro can call, walking away already costs the
// customer a cancellation fee — so the arithmetic of the side deal collapses on
// its own, with no accusation and no enforcement required.
//
// This is a DATA-MINIMIZATION policy, not a communication ban. Easers may
// always reach the customer through the platform relay (see booking/message),
// and the contractor agreement already governs solicitation (Section 11). That
// distinction matters legally: restricting platform data is the company's
// prerogative, while dictating how an independent contractor communicates
// edges toward the behavioral control that supports worker misclassification.
export const CONTACT_RELEASE_LEAD_HOURS = 24;

// Once a pro is physically committed to the job, contact is released no matter
// what the clock says. A pro standing at a door they cannot get into is a
// worse failure than an early release, and this branch means no date bug,
// timezone edge, or malformed slot can ever stand someone up.
const PHYSICALLY_COMMITTED_STATUSES = Object.freeze([
  BOOKING_STATUS.EN_ROUTE,
  BOOKING_STATUS.ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
]);

export const CONTACT_RELEASE_CODE = Object.freeze({
  RELEASED: 'released',
  NOT_ACCEPTED: 'not_accepted',
  NOT_ACTIVE: 'not_active',
  PENDING_LEAD_TIME: 'pending_lead_time',
});

/**
 * Which appointment does this booking actually turn on? A completed job held
 * open for a return visit is worked on the RETURN date, so the release window
 * has to track that date rather than the original one.
 */
export function effectiveAppointment(booking = {}) {
  return booking.return_visit_required
    ? { date: booking.return_visit_date, time: booking.return_visit_time }
    : { date: booking.date, time: booking.time };
}

/**
 * Decide whether customer phone/email may be shown for one booking.
 *
 * `scopeVisible` covers name/address/job details (released at acceptance).
 * `released` covers phone/email (held until the pre-appointment window).
 *
 * @returns {{released:boolean, scopeVisible:boolean, code:string, releasesAt:(string|null), leadHours:number, reason:(string|null)}}
 */
export function evaluateCustomerContactRelease(booking = {}, nowMs = Date.now()) {
  const leadHours = CONTACT_RELEASE_LEAD_HOURS;
  const base = { released: false, scopeVisible: false, code: CONTACT_RELEASE_CODE.NOT_ACCEPTED, releasesAt: null, leadHours, reason: null };

  // Gate 1 — acceptance. Unchanged, long-standing rule: an open offer never
  // carries customer data, or every pro who was merely asked would hold it.
  if (!booking.assembler_accepted_at) return base;

  // Gate 2 — the job is live. Terminal history is stripped so a finished job
  // does not leave a pro holding a standing list of customer contacts.
  const hasOpenReturnVisit = booking.status === BOOKING_STATUS.COMPLETED
    && booking.return_visit_required === true;
  if (!ACTIVE_BOOKING_STATUSES.includes(booking.status) && !hasOpenReturnVisit) {
    return { ...base, code: CONTACT_RELEASE_CODE.NOT_ACTIVE };
  }

  // Past both gates the pro is working this job, so the job scope is theirs.
  const scoped = { ...base, scopeVisible: true };

  // Gate 3 — lead time, with the two safety valves described above.
  if (PHYSICALLY_COMMITTED_STATUSES.includes(booking.status)) {
    return { ...scoped, released: true, code: CONTACT_RELEASE_CODE.RELEASED };
  }

  const { date, time } = effectiveAppointment(booking);
  const appointmentMs = appointmentTimestampMs(date, time);
  if (!Number.isFinite(appointmentMs)) {
    // Unreadable appointment time. Release rather than withhold: the pro has
    // already accepted a live job that may be today, and the booking is
    // already broken in a way the owner must repair. Never strand the pro.
    return {
      ...scoped,
      released: true,
      code: CONTACT_RELEASE_CODE.RELEASED,
      reason: 'appointment_time_unreadable',
    };
  }

  const releasesAtMs = appointmentMs - leadHours * 60 * 60 * 1000;
  if (Number(nowMs) >= releasesAtMs) {
    return { ...scoped, released: true, code: CONTACT_RELEASE_CODE.RELEASED, releasesAt: new Date(releasesAtMs).toISOString() };
  }

  return {
    ...scoped,
    code: CONTACT_RELEASE_CODE.PENDING_LEAD_TIME,
    releasesAt: new Date(releasesAtMs).toISOString(),
  };
}
