export function loadBookingRescheduleTruth(booking) {
  if (!booking?.id) {
    const error = new Error('Booking reschedule truth input is incomplete.');
    error.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw error;
  }
  const rescheduleCount = Number(booking.reschedule_count);
  if (!Number.isInteger(rescheduleCount) || rescheduleCount < 0) {
    const truthError = new Error('Cancellation history could not be verified. Apply migration 037 before taking a cancellation payment action.');
    truthError.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw truthError;
  }
  return { wasRescheduled: rescheduleCount > 0, rescheduleCount };
}
