import { BOOKING_STATUS } from '../_source-of-truth.js';
import { awaitingReplacementPro } from './_easer-no-show.js';
import { formatAppointmentDateShort } from './_appt-date.js';

// "Arriving Tue, Oct 20, between 10:00 AM and 12:00 PM." The whole window the
// customer booked, never only its start.
function arrivingText(b) {
  const day = formatAppointmentDateShort(b.date);
  const parts = String(b.time || '').split(/[-–—]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return `Arriving ${day}, between ${parts[0]} and ${parts[parts.length - 1]}.`;
  if (parts.length === 1) return `Arriving ${day} at ${parts[0]}.`;
  return `Arriving ${day}.`;
}

/**
 * THE words a customer sees for where their booking stands. Read by
 * api/booking/track.js (the booking page and the customer app's booking
 * screen) and api/booking/customer-bookings.js (the app's booking list), so a
 * booking never reads one way in the list and another when opened.
 *
 * Needs: status, payment_status, payment_collected, return_visit_required,
 * return_visit_date, return_visit_time, assembler_id, assembler_accepted_at,
 * assembler_name, date, time, easer_no_show_confirmed_at.
 */
export function customerStatusLabel(b) {
  if (b.status === BOOKING_STATUS.CANCELLED) return { label: 'Booking cancelled', detail: null };
  if (b.status === BOOKING_STATUS.DECLINED)  return { label: 'Booking could not be confirmed', detail: 'Please contact us to reschedule.' };
  if (b.return_visit_required) {
    return {
      label: 'Return appointment scheduled',
      detail: `We will return ${b.return_visit_date || 'on the confirmed date'}${b.return_visit_time ? ` at ${b.return_visit_time}` : ''} to complete the remaining work.`,
    };
  }
  if (b.status === BOOKING_STATUS.COMPLETED) {
    const paymentProcessed = b.payment_collected === true
      || ['captured', 'deposit_paid', 'partially_refunded', 'refunded'].includes(String(b.payment_status || '').toLowerCase());
    return {
      label: 'Job complete — thank you!',
      detail: paymentProcessed ? 'Payment has been processed.' : 'Your booking is complete.',
    };
  }
  if (b.status === BOOKING_STATUS.IN_PROGRESS) return { label: 'Work is underway', detail: null };
  if (b.status === BOOKING_STATUS.ARRIVED)     return { label: 'Your service pro has arrived', detail: null };
  if (b.status === BOOKING_STATUS.EN_ROUTE)    return { label: 'Your service pro is on the way', detail: null };
  if (awaitingReplacementPro(b)) {
    return { label: 'We are finding you a new pro', detail: 'We will confirm your pro and new time with you. You will not be charged for the missed visit.' };
  }
  if (b.assembler_accepted_at && b.assembler_name) {
    const first = (b.assembler_name || '').split(' ')[0];
    return { label: `${first} is confirmed for your job`, detail: arrivingText(b) };
  }
  if (b.status === BOOKING_STATUS.CONFIRMED && b.payment_status === 'card_saved') {
    return {
      label: 'Appointment reserved',
      detail: 'Nothing has been charged. You pay after the job is done. We contact you only if your bank needs another confirmation.',
    };
  }
  if (b.assembler_id) return { label: 'Matching you with a service pro', detail: 'Your pro will confirm shortly.' };
  if (b.status === BOOKING_STATUS.CONFIRMED) return { label: 'Matching you with a service pro', detail: 'We will notify you once your service pro is confirmed.' };
  return { label: 'Booking received', detail: 'We will confirm your appointment shortly.' };
}

/**
 * Where a booking is on its way to done, for the step tracker in the customer
 * app: Booked, Pro confirmed, On the way, Arrived, Done. Null when there is
 * nothing to track (cancelled, declined, or a return visit being arranged).
 * Same fields as customerStatusLabel.
 */
/**
 * A card checkout that never completed: the booking row exists (the owner sees
 * it as an attempt) but the card was never held. The customer's own list leaves
 * it out; a booking only appears there once it is real.
 */
export function customerCheckoutUnfinished(b) {
  return b.status === BOOKING_STATUS.PENDING
    && ['pending', 'failed'].includes(String(b.payment_status || ''))
    && !!b.stripe_payment_intent_id;
}

export const CUSTOMER_PROGRESS_STEPS = Object.freeze(['Booked', 'Pro confirmed', 'On the way', 'Arrived', 'Done']);

export function customerProgress(b) {
  if (b.status === BOOKING_STATUS.CANCELLED || b.status === BOOKING_STATUS.DECLINED || b.return_visit_required) return null;
  let step = 0;
  if (b.status === BOOKING_STATUS.COMPLETED) step = 4;
  else if (b.status === BOOKING_STATUS.ARRIVED || b.status === BOOKING_STATUS.IN_PROGRESS) step = 3;
  else if (b.status === BOOKING_STATUS.EN_ROUTE) step = 2;
  else if (b.assembler_accepted_at && !awaitingReplacementPro(b)) step = 1;
  return { step, steps: CUSTOMER_PROGRESS_STEPS };
}
