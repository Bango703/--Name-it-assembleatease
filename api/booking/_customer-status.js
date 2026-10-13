import { BOOKING_STATUS } from '../_source-of-truth.js';

/**
 * THE words a customer sees for where their booking stands. Read by
 * api/booking/track.js (the booking page and the customer app's booking
 * screen) and api/booking/customer-bookings.js (the app's booking list), so a
 * booking never reads one way in the list and another when opened.
 *
 * Needs: status, payment_status, payment_collected, return_visit_required,
 * return_visit_date, return_visit_time, assembler_id, assembler_accepted_at,
 * assembler_name, date, time.
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
  if (b.status === BOOKING_STATUS.CONFIRMED && b.payment_status === 'card_saved') {
    return {
      label: 'Appointment reserved',
      detail: 'Your card is saved securely. We will verify it closer to your appointment and contact you only if another confirmation is needed.',
    };
  }
  if (b.assembler_accepted_at && b.assembler_name) {
    const first = (b.assembler_name || '').split(' ')[0];
    return { label: `${first} is confirmed for your job`, detail: `Arriving ${b.date}${b.time ? ' at ' + b.time.split('-')[0].trim() : ''}.` };
  }
  if (b.assembler_id) return { label: 'Matching you with a service pro', detail: 'Your pro will confirm shortly.' };
  if (b.status === BOOKING_STATUS.CONFIRMED) return { label: 'Matching you with a service pro', detail: 'We will notify you once your service pro is confirmed.' };
  return { label: 'Booking received', detail: 'We will confirm your appointment shortly.' };
}
