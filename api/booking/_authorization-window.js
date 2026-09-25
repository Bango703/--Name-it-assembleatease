/**
 * Will this authorization still be capturable when the job is finished?
 *
 * THE INCIDENT IT EXISTS FOR
 * AAE-DVSNHXE4OO: booked 2026-09-19 for 2026-09-24, authorized on the spot
 * because IMMEDIATE_AUTHORIZATION_DAYS is 6 and the appointment was 5 days out.
 * That rule assumes a 7-day hold. A Visa merchant-initiated authorization lasts
 * 4 days and 18 hours, so the money stopped being capturable on 2026-09-23. The
 * Easer did the work on the 24th, pressed complete, and capture failed. Nothing
 * had checked, because nothing knew when the hold ended.
 *
 * Stripe reports the real deadline per charge, in
 * charge.payment_method_details.card.capture_before, accounting for the card
 * brand and for merchant- versus customer-initiated. We store that and read it.
 * Counting days would be wrong for Visa MIT today and wrong again whenever a
 * network changes a window.
 *
 * ONE ANSWER, THREE READERS
 * The pre-dispatch gate, the renewal monitor and the owner dashboard all ask
 * this module. If they each decided for themselves they would disagree, and the
 * disagreement would only show up as a failed capture on a finished job.
 *
 * WHAT IT WILL NOT DO
 * It does not authorize, capture, cancel or change any booking. It answers a
 * question. The canonical flow — authorize, hold, work, capture the existing
 * authorization — is untouched.
 */

import { appointmentTimestampMs } from './_appt-date.js';

/**
 * How long after the appointment window opens we still expect to be capturing.
 * A two-hour slot that starts at 8am can reasonably finish at 2pm once the job
 * runs long, so readiness is judged against the end of the day, not the slot.
 */
export const EXPECTED_COMPLETION_BUFFER_HOURS = 12;

/**
 * Renew this far ahead of the deadline. Wide enough that a customer has a day
 * to act on the email before the hold dies, and that a failed renewal can be
 * retried on the next run rather than being the last chance.
 */
export const RENEWAL_LEAD_HOURS = 48;

/** Reasons, so callers branch on a value rather than matching a sentence. */
export const AUTHORIZATION_WINDOW = Object.freeze({
  OK: 'authorization_covers_completion',
  NOT_AUTHORIZED: 'not_authorized',
  DEADLINE_UNKNOWN: 'capture_deadline_unknown',
  APPOINTMENT_UNREADABLE: 'appointment_unreadable',
  EXPIRES_BEFORE_COMPLETION: 'authorization_expires_before_completion',
  ALREADY_EXPIRED: 'authorization_already_expired',
});

function ms(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

/** The moment Stripe stops letting us capture, or null when it was never recorded. */
export function captureDeadlineMs(booking = {}) {
  return ms(booking.authorization_capture_before);
}

/**
 * The latest we should still expect to be capturing for this booking. Uses the
 * return-visit date once one is open, because that is when the work actually
 * finishes and therefore when the money is taken.
 */
export function expectedCompletionMs(booking = {}) {
  const useReturn = booking.return_visit_required === true && booking.return_visit_date;
  const date = useReturn ? booking.return_visit_date : booking.date;
  const time = useReturn ? booking.return_visit_time : booking.time;
  const start = appointmentTimestampMs(date, time);
  if (!Number.isFinite(start)) return null;
  return start + EXPECTED_COMPLETION_BUFFER_HOURS * 3600000;
}

/**
 * The verdict. `ok` only when we positively know the hold outlives the job.
 *
 * An unrecorded deadline is NOT ok. Treating unknown as fine is the assumption
 * that produced the incident, and a booking authorized before the deadline was
 * recorded genuinely cannot be vouched for.
 */
export function evaluateAuthorizationWindow(booking = {}, nowMs = Date.now()) {
  const deadline = captureDeadlineMs(booking);
  const completion = expectedCompletionMs(booking);
  const base = { deadline, expectedCompletion: completion };

  if (String(booking.payment_status || '') !== 'authorized') {
    return { ok: false, reason: AUTHORIZATION_WINDOW.NOT_AUTHORIZED, ...base };
  }
  if (deadline == null) {
    return { ok: false, reason: AUTHORIZATION_WINDOW.DEADLINE_UNKNOWN, ...base };
  }
  if (deadline <= nowMs) {
    return { ok: false, reason: AUTHORIZATION_WINDOW.ALREADY_EXPIRED, ...base };
  }
  if (completion == null) {
    // The slot cannot be read, so the job could finish at any hour of that day.
    // Judged against the deadline alone rather than guessed at.
    return { ok: false, reason: AUTHORIZATION_WINDOW.APPOINTMENT_UNREADABLE, ...base };
  }
  if (deadline < completion) {
    return { ok: false, reason: AUTHORIZATION_WINDOW.EXPIRES_BEFORE_COMPLETION, ...base };
  }
  return { ok: true, reason: AUTHORIZATION_WINDOW.OK, ...base };
}

/**
 * Should the monitor act on this booking now?
 *
 * True when the hold will not survive the job, or is inside the renewal lead
 * time. Deliberately fires EARLY: the point is to resolve it before the
 * appointment, not to discover it at capture.
 */
export function needsAuthorizationRenewal(booking = {}, nowMs = Date.now()) {
  const verdict = evaluateAuthorizationWindow(booking, nowMs);
  if (verdict.reason === AUTHORIZATION_WINDOW.NOT_AUTHORIZED) return false;
  if (!verdict.ok) return true;
  return verdict.deadline - nowMs <= RENEWAL_LEAD_HOURS * 3600000;
}

/**
 * PAST_APPOINTMENT_NOT_COMPLETE
 *
 * The time the job should have finished has gone and nobody closed it. True
 * whatever the payment arrangement, because a job that is never closed is an
 * operational problem on its own: the Easer is unpaid, the customer has no
 * completion, and no evidence was ever filed.
 */
export function pastAppointmentNotComplete(booking = {}, nowMs = Date.now()) {
  if (['completed', 'cancelled', 'declined', 'refunded'].includes(String(booking.status || ''))) return false;
  if (booking.completed_at) return false;
  const end = expectedCompletionMs(booking);
  return Number.isFinite(end) && end < nowMs;
}

/**
 * AUTHORIZED_PAYMENT_STILL_OPEN
 *
 * The customer's money is held and has not been taken. Says nothing about
 * timing on its own — every healthy booking between authorization and
 * completion is in this state. It is only a problem in company.
 */
export function authorizedPaymentStillOpen(booking = {}) {
  return String(booking.payment_status || '') === 'authorized'
    && !booking.payment_collected
    && !booking.completed_at;
}

/**
 * The four words the owner dashboard shows. No Stripe vocabulary: the dashboard
 * is an operator console, but these are states of the booking, not of an API.
 */
export function authorizationReadinessLabel(booking = {}, nowMs = Date.now()) {
  const status = String(booking.payment_status || '');
  if (status === 'captured' || status === 'partially_refunded') return 'Payment collected';
  const verdict = evaluateAuthorizationWindow(booking, nowMs);
  if (verdict.ok) {
    return needsAuthorizationRenewal(booking, nowMs) ? 'Authorization expiring' : 'Payment ready';
  }
  if (verdict.reason === AUTHORIZATION_WINDOW.NOT_AUTHORIZED) return 'Payment action required';
  return 'Payment action required';
}

/**
 * Pull Stripe's deadline off a PaymentIntent so every authorization path
 * records it the same way. Returns null when the shape is not what we expect,
 * which callers must store as null rather than inventing a date.
 */
export function captureBeforeFromIntent(intent) {
  const charge = intent?.latest_charge && typeof intent.latest_charge === 'object'
    ? intent.latest_charge
    : intent?.charges?.data?.[0];
  const seconds = charge?.payment_method_details?.card?.capture_before;
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

/**
 * Ask Stripe for the deadline after an authorization succeeds.
 *
 * A SEPARATE read rather than an `expand` on the confirm/create call. Those
 * calls carry idempotency keys, and a replay returns the original response —
 * so adding expand there would silently yield nothing on exactly the retries
 * that matter most. This cannot disturb the authorization because it only
 * reads, and a failure returns null, which callers store as "not recorded".
 * Never let this break a payment that already went through.
 */
export async function fetchCaptureDeadline(stripe, intentId) {
  if (!stripe || !intentId) return null;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    return captureBeforeFromIntent(intent);
  } catch (error) {
    console.error('[authorization-window] could not read capture_before for', intentId, error?.message);
    return null;
  }
}
