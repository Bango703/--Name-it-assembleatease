// ─── What counts as an active job, and what stage it is at ──────────────────
//
// Live Ops showed "1 Active Jobs" directly above "No active jobs right now" on
// 2026-09-22. Both statements came from the same payload. The count was made on
// the server (every operational booking except 'pending') and the list was made
// in the browser (enRoute + arrived + inProgress + awaitingAcceptance), so a
// booking that was confirmed, staffed AND accepted — the healthiest state a job
// reaches before the day itself — was counted by one and shown by neither. The
// owner had to leave Live Ops and open the Bookings page to find his only live
// job.
//
// One rule, one module, one list. The count is the list's length and the stage
// is decided here, so the panel renders a verdict instead of making one
// (Articles 1, 2 and 4).

// Ordered by what an operator needs to see first: work happening right now,
// then work that is set, then work still waiting on someone.
export const ACTIVE_JOB_STAGE_ORDER = Object.freeze([
  'in_progress',
  'arrived',
  'en_route',
  'scheduled',
  'awaiting_accept',
  'needs_easer',
  'return_visit',
]);

/** The date/time an operator cares about: the return visit when one is open. */
export function operationalDate(booking) {
  return booking?.return_visit_required ? booking.return_visit_date : booking?.date;
}

export function operationalTime(booking) {
  return booking?.return_visit_required ? booking.return_visit_time : booking?.time;
}

/**
 * Which bookings are operational at all: everything that is not cancelled or
 * declined, and not finished — a completed job still counts while it owes a
 * return visit.
 */
export function isOperationalBooking(booking) {
  if (!booking) return false;
  const status = String(booking.status || '');
  if (['cancelled', 'declined'].includes(status)) return false;
  return status !== 'completed' || booking.return_visit_required === true;
}

/**
 * The stage an operator would name out loud. 'scheduled' is the one that had no
 * home before: assigned, accepted, and simply waiting for the day.
 */
export function activeJobStage(booking) {
  const status = String(booking?.status || '');
  if (status === 'completed') return 'return_visit';
  if (status === 'in_progress') return 'in_progress';
  if (status === 'arrived') return 'arrived';
  if (status === 'en_route') return 'en_route';
  if (!booking?.assembler_id) return 'needs_easer';
  if (!booking?.assembler_accepted_at) return 'awaiting_accept';
  return 'scheduled';
}

/**
 * The list Live Ops shows and counts.
 *
 * 'pending' is excluded because those bookings have not been paid for yet and
 * live in the payment panels; everything else that is operational appears here,
 * so no job can be counted without being visible.
 *
 * @param {Array} operationalBookings bookings already filtered by isOperationalBooking
 * @returns {Array} each booking with _stage, _stage_date and _stage_time
 */
export function buildActiveJobs(operationalBookings = []) {
  return operationalBookings
    .filter(booking => String(booking?.status || '') !== 'pending')
    .map(booking => ({
      ...booking,
      _stage: activeJobStage(booking),
      _stage_date: operationalDate(booking),
      _stage_time: operationalTime(booking),
    }))
    .sort((a, b) => {
      const byStage = ACTIVE_JOB_STAGE_ORDER.indexOf(a._stage) - ACTIVE_JOB_STAGE_ORDER.indexOf(b._stage);
      if (byStage !== 0) return byStage;
      return String(a._stage_date || '').localeCompare(String(b._stage_date || ''));
    });
}
