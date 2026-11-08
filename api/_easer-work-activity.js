// An Easer's current work as the owner sees it on the Easer detail, read from
// bookings rather than the nightly active_jobs_today counter. Jobs reach an
// Easer by dispatch or by owner assignment, and both count the same (owner,
// 2026-10-28). Used by api/assembler/list.js.
import { ACTIVE_BOOKING_STATUSES } from './_source-of-truth.js';
import { chicagoTodayIso } from './booking/_appt-date.js';
import { acceptanceRateFor, ACCEPTANCE_MIN_DECISIONS, ACCEPTANCE_WINDOW_DAYS } from './_easer-acceptance.js';

// Open jobs: every active booking assigned to the Easer, accepted or still
// waiting on them. Jobs today: those whose next visit is today (a return visit
// counts on its own date). null when bookings could not be read, so the
// dashboard shows "Unavailable" rather than a confident 0.
export async function loadOpenWork(sb, today = chicagoTodayIso()) {
  let result;
  try {
    result = await sb.from('bookings')
      .select('assembler_id, date, assembler_accepted_at, return_visit_required, return_visit_date')
      .in('status', ACTIVE_BOOKING_STATUSES)
      .not('assembler_id', 'is', null);
  } catch (error) {
    result = { data: null, error };
  }
  if (result.error) {
    console.error('Easer open-work read error:', result.error.message || result.error);
    return null;
  }
  const byEaser = new Map();
  for (const b of result.data || []) {
    const w = byEaser.get(b.assembler_id) || { openJobs: 0, awaitingAcceptance: 0, jobsToday: 0 };
    w.openJobs += 1;
    if (!b.assembler_accepted_at) w.awaitingAcceptance += 1;
    const visitDate = b.return_visit_required && b.return_visit_date ? b.return_visit_date : b.date;
    if (String(visitDate || '').slice(0, 10) === today) w.jobsToday += 1;
    byEaser.set(b.assembler_id, w);
  }
  return byEaser;
}

// The 30-day acceptance is what tiers use; the all-time count sits beside it
// so an Easer with few recent offers still shows their whole record.
export function workActivityFor(easerId, workByEaser, tallies, allTimeTallies = null) {
  const empty = { accepted: 0, declined: 0, expired: 0, total: 0 };
  const work = workByEaser ? (workByEaser.get(easerId) || { openJobs: 0, awaitingAcceptance: 0, jobsToday: 0 }) : null;
  const tally = tallies ? (tallies.get(easerId) || empty) : null;
  const allTime = allTimeTallies ? (allTimeTallies.get(easerId) || empty) : null;
  return {
    openJobs: work ? work.openJobs : null,
    awaitingAcceptance: work ? work.awaitingAcceptance : null,
    jobsToday: work ? work.jobsToday : null,
    acceptance: tally ? {
      ...tally,
      rate: acceptanceRateFor(tally),
      windowDays: ACCEPTANCE_WINDOW_DAYS,
      minDecisions: ACCEPTANCE_MIN_DECISIONS,
    } : null,
    acceptanceAllTime: allTime ? { ...allTime } : null,
  };
}
