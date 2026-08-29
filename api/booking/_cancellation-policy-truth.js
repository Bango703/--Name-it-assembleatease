export function loadBookingRescheduleTruth(booking) {
  if (!booking?.id) {
    const error = new Error('Booking reschedule truth input is incomplete.');
    error.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw error;
  }
  const rescheduleCount = Number(booking.reschedule_count);
  if (!Number.isInteger(rescheduleCount) || rescheduleCount < 0) {
    // Same false cause as the other three: 037 is applied, and a null
    // reschedule_count on an older booking is a per-booking gap, not a
    // missing migration.
    const truthError = new Error('This booking has no reschedule history recorded, so the cancellation policy cannot be applied safely. Reconcile it before taking a payment action.');
    truthError.code = 'CANCELLATION_POLICY_TRUTH_UNAVAILABLE';
    throw truthError;
  }
  return { wasRescheduled: rescheduleCount > 0, rescheduleCount };
}
