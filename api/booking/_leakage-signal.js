import { appointmentTimestampMs } from './_appt-date.js';
import { BOOKING_STATUS, CANCELLATION_POLICY } from '../_source-of-truth.js';

// ─── Off-platform leakage signal ─────────────────────────────────────────────
//
// Holding back the customer's phone until the free-cancellation window closes
// makes a pre-job side deal harder. It does not make it visible. Without this,
// the owner has no way to know whether leakage ever happened, whether the
// contact window helped, or which pro to talk to.
//
// The pattern worth watching is narrow and specific: a pro ACCEPTS a job, and
// the customer then cancels while cancelling is still free. That is the shape a
// side deal leaves behind, because both sides need the booking gone before a
// fee attaches. A cancellation inside the fee window is a different animal —
// the customer paid to cancel, which is the opposite of a bargain.
//
// This is a SIGNAL, never a verdict. Customers cancel for ordinary reasons all
// the time, and at low job volume one cancellation means nothing. The output
// therefore always carries the sample size so the number can never be read
// without the context that qualifies it.

export const LEAKAGE_WINDOW_DAYS = 90;
// Below this many accepted jobs, a rate is arithmetic noise and is reported
// but never flagged.
export const LEAKAGE_MIN_SAMPLE = 4;
// Flagged only when the pro's free-cancel rate is at least this high AND the
// sample is meaningful.
export const LEAKAGE_FLAG_RATE_PCT = 40;

function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / 3600000;
}

/**
 * @param {{bookings:Array, easers:Array, nowMs?:number, windowDays?:number}} args
 * @returns {{windowDays:number, generatedFrom:string, easers:Array, flaggedCount:number, totalFreeCancelAfterAccept:number}}
 */
export function computeLeakageSignals({ bookings = [], easers = [], nowMs = Date.now(), windowDays = LEAKAGE_WINDOW_DAYS } = {}) {
  const since = nowMs - windowDays * 24 * 3600000;
  const nameById = new Map(easers.map(e => [e.id, e.full_name || e.email || 'Easer']));
  const byEaser = new Map();

  for (const booking of bookings) {
    const easerId = booking.assembler_id;
    if (!easerId || !booking.assembler_accepted_at) continue;
    const acceptedMs = new Date(booking.assembler_accepted_at).getTime();
    if (!Number.isFinite(acceptedMs) || acceptedMs < since) continue;

    if (!byEaser.has(easerId)) {
      byEaser.set(easerId, { easerId, easerName: nameById.get(easerId) || 'Easer', accepted: 0, freeCancelAfterAccept: 0, refs: [] });
    }
    const row = byEaser.get(easerId);
    row.accepted += 1;

    if (booking.status !== BOOKING_STATUS.CANCELLED || !booking.cancelled_at) continue;
    const cancelledMs = new Date(booking.cancelled_at).getTime();
    const appointmentMs = appointmentTimestampMs(booking.date, booking.time);
    // An unreadable appointment cannot be classified. Counting it would invent
    // a signal about a real person from data we could not read.
    if (!Number.isFinite(cancelledMs) || !Number.isFinite(appointmentMs)) continue;

    if (hoursBetween(appointmentMs, cancelledMs) >= CANCELLATION_POLICY.freeWindowHours) {
      row.freeCancelAfterAccept += 1;
      if (booking.ref) row.refs.push(booking.ref);
    }
  }

  const rows = [...byEaser.values()].map(row => {
    const ratePct = row.accepted > 0 ? Math.round((row.freeCancelAfterAccept / row.accepted) * 100) : 0;
    const sampleMeaningful = row.accepted >= LEAKAGE_MIN_SAMPLE;
    return {
      ...row,
      refs: row.refs.slice(0, 5),
      ratePct,
      sampleMeaningful,
      flagged: sampleMeaningful && ratePct >= LEAKAGE_FLAG_RATE_PCT,
    };
  }).sort((a, b) => (b.flagged - a.flagged) || (b.ratePct - a.ratePct) || (b.accepted - a.accepted));

  return {
    windowDays,
    generatedFrom: new Date(since).toISOString(),
    minSample: LEAKAGE_MIN_SAMPLE,
    flagRatePct: LEAKAGE_FLAG_RATE_PCT,
    easers: rows,
    flaggedCount: rows.filter(r => r.flagged).length,
    totalFreeCancelAfterAccept: rows.reduce((sum, r) => sum + r.freeCancelAfterAccept, 0),
  };
}
