// A confirmed Easer no-show protects the customer (owner, 2026-11-08, after
// Santiago missed an 8-10 AM job with no contact and the customer's tracking
// page offered her a reschedule that would have ended her free cancellation).
//
// api/owner/confirm-no-show.js stamps bookings.easer_no_show_confirmed_at
// (migration 126). From then on, for this booking:
//   - no cancellation fee applies to the customer (computeCancellationFee,
//     reason 'easer_no_show'), unless the owner flags a later customer no-show;
//   - a reschedule does not count toward her limit or end her free window;
//   - until a new pro accepts, she is told we are finding her a new pro.
// Rule 9 and Rule 16: the customer never pays or does extra work for an Easer
// who did not come.

export function easerMissedVisit(booking) {
  return Boolean(booking?.easer_no_show_confirmed_at);
}

/** Missed by an Easer, and no pro has accepted the job since. */
export function awaitingReplacementPro(booking) {
  if (!easerMissedVisit(booking)) return false;
  const acceptedMs = Date.parse(booking.assembler_accepted_at || '');
  const missedMs = Date.parse(booking.easer_no_show_confirmed_at);
  return !(Number.isFinite(acceptedMs) && Number.isFinite(missedMs) && acceptedMs > missedMs);
}
