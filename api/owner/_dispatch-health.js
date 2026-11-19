// Dispatch health for one service market (owner, 2026-11-18: "track dispatch
// acceptance rates, assignment times, unassigned bookings, cancellations, and
// fulfillment"; "use operational problems to trigger recruitment and
// escalation, not geographic advertising restrictions").
//
// Pure: takes rows, returns the report. Every count the dashboard shows is the
// length of a list this module also returns (CLAUDE.md, count = list), and
// every rate names the rows it was computed from.
import { BOOKING_STATUS, DISPATCH_OFFER_STATUS, SERVICE_MARKETS } from '../_source-of-truth.js';

export const DISPATCH_HEALTH_WINDOW_DAYS = 30;

// Recruitment triggers. Any one firing starts a recruitment push for the
// market; none of them limits advertising or booking.
export const RECRUITMENT_TRIGGERS = Object.freeze({
  minAcceptanceRate: 0.6,          // below 60% of answered or lapsed offers
  minOffersForRate: 5,             // ... once at least 5 offers were answered or lapsed
  maxMedianMinutesToAssign: 60,    // median confirmation-to-acceptance above an hour
  minAssignmentsForMedian: 3,
  unassignedWithinHours: 24,       // a confirmed job still unassigned this close to its appointment
  maxWeeklyBookingsPerEaser: 5,    // confirmed jobs in the last 7 days per ready Easer
});

const MARKET_LABELS = Object.freeze({ houston: 'Greater Houston' });

export function marketPrefixes(market) {
  return SERVICE_MARKETS[market] ? [...SERVICE_MARKETS[market]] : [];
}

export function zipInMarket(zip, market) {
  const z = String(zip || '').trim();
  return /^\d{5}/.test(z) && marketPrefixes(market).includes(z.slice(0, 3));
}

function ms(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

// Appointment start in America/Chicago, approximated as the date at noon when
// the time is not parseable. Only used for "within 24 hours" urgency.
function appointmentMs(booking) {
  const date = String(booking.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const m = String(booking.time || '').match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  let hour = 12, minute = 0;
  if (m) {
    hour = Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0);
    if (!m[3] && Number(m[1]) >= 0 && Number(m[1]) <= 23) hour = Number(m[1]);
    minute = Number(m[2] || 0);
  }
  // Central Time is UTC-6 (CST) or UTC-5 (CDT); -6 is the conservative choice
  // for "how soon": it never makes an appointment look later than it is by more than an hour.
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour + 6, minute);
}

function bookingRow(b, extra = {}) {
  return {
    ref: b.ref || null,
    service: b.service || null,
    city: b.service_city || null,
    zip: b.service_zip || null,
    date: b.date || null,
    time: b.time || null,
    status: b.status || null,
    ...extra,
  };
}

function isCustomerCancellation(reason) {
  return /^cancelled by customer/i.test(String(reason || '').trim());
}

/**
 * @param {object} input
 * @param {Array} input.bookings  non-test bookings in the market (any age)
 * @param {Array} input.offers    dispatch_offers rows for those bookings
 * @param {Array} input.easers    Easer profiles in the market, each with `isReady` (readiness verdict)
 * @param {string} input.market   SERVICE_MARKETS key
 * @param {Date|number} input.now
 */
export function buildDispatchHealth({ bookings = [], offers = [], easers = [], market = 'houston', now = Date.now(), windowDays = DISPATCH_HEALTH_WINDOW_DAYS } = {}) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const since = nowMs - windowDays * 86400000;
  const inMarket = bookings.filter(b => b && b.is_test_booking !== true && zipInMarket(b.service_zip, market));
  const windowed = inMarket.filter(b => (ms(b.created_at) ?? 0) >= since);
  const ids = new Set(windowed.map(b => b.id));
  const windowOffers = offers.filter(o => ids.has(o.booking_id));

  // Time to assignment: confirmation (or creation) to the Easer's acceptance.
  const assignmentRows = windowed
    .map(b => {
      const start = ms(b.confirmed_at) ?? ms(b.created_at);
      const end = ms(b.assembler_accepted_at) ?? ms(b.assigned_at);
      return start != null && end != null && end >= start && b.assembler_id
        ? bookingRow(b, { minutesToAssign: Math.round((end - start) / 60000) })
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.minutesToAssign - a.minutesToAssign);
  const minutes = assignmentRows.map(r => r.minutesToAssign);

  // Offer acceptance: accepted out of offers that were answered or lapsed.
  const counted = windowOffers.filter(o => [DISPATCH_OFFER_STATUS.ACCEPTED, DISPATCH_OFFER_STATUS.DECLINED, DISPATCH_OFFER_STATUS.EXPIRED].includes(o.offer_status));
  const accepted = counted.filter(o => o.offer_status === DISPATCH_OFFER_STATUS.ACCEPTED);
  const firstAttempt = new Map();
  for (const o of windowOffers) {
    if (Number(o.attempt_number || 1) !== 1) continue;
    const cur = firstAttempt.get(o.booking_id) || false;
    firstAttempt.set(o.booking_id, cur || o.offer_status === DISPATCH_OFFER_STATUS.ACCEPTED);
  }

  // Live lists (not windowed): what needs action now.
  const unassigned = inMarket
    .filter(b => b.status === BOOKING_STATUS.CONFIRMED && !b.assembler_id)
    .map(b => {
      const appt = appointmentMs(b);
      const hoursToAppointment = appt == null ? null : Math.round((appt - nowMs) / 3600000);
      const minutesWaiting = ms(b.confirmed_at) != null ? Math.round((nowMs - ms(b.confirmed_at)) / 60000) : null;
      return bookingRow(b, { hoursToAppointment, minutesWaiting, needsManualDispatch: b.needs_manual_dispatch === true, dispatchPaused: b.dispatch_paused === true });
    })
    .sort((a, b) => (a.hoursToAppointment ?? 1e9) - (b.hoursToAppointment ?? 1e9));
  const manualFlagged = unassigned.filter(r => r.needsManualDispatch || r.dispatchPaused);

  const cancellations = windowed
    .filter(b => [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED].includes(b.status))
    .map(b => {
      const reason = b.cancel_reason || b.decline_reason || null;
      const neverAssigned = !b.assembler_id && !b.assigned_at && !b.assembler_accepted_at;
      return bookingRow(b, { reason, neverAssigned, noEaserTookIt: neverAssigned && !isCustomerCancellation(reason) });
    });
  const completedJobs = windowed.filter(b => b.status === BOOKING_STATUS.COMPLETED).map(b => bookingRow(b, { completedAt: b.completed_at || null }));
  const confirmedEver = windowed.filter(b => ms(b.confirmed_at) != null || [BOOKING_STATUS.COMPLETED, BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.EN_ROUTE, BOOKING_STATUS.ARRIVED, BOOKING_STATUS.IN_PROGRESS].includes(b.status));

  const readyEasers = easers.filter(e => e && e.isReady === true);
  const weekAgo = nowMs - 7 * 86400000;
  const confirmedLastWeek = inMarket.filter(b => (ms(b.confirmed_at) ?? -1) >= weekAgo).length;
  const perEaserWeek = readyEasers.length ? confirmedLastWeek / readyEasers.length : null;

  // Daily cap hits: an Easer with dispatchCap or more jobs on one appointment date.
  const dailyCap = Number(process.env.DISPATCH_MAX_DAILY_JOBS || 3);
  const perEaserDay = new Map();
  for (const b of inMarket) {
    if (!b.assembler_id || !b.date || [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.DECLINED, BOOKING_STATUS.REFUNDED].includes(b.status)) continue;
    const key = `${b.assembler_id}|${String(b.date).slice(0, 10)}`;
    perEaserDay.set(key, (perEaserDay.get(key) || 0) + 1);
  }
  const capHits = [...perEaserDay.entries()].filter(([, n]) => n >= dailyCap).map(([key, jobs]) => ({ date: key.split('|')[1], jobs }));

  const T = RECRUITMENT_TRIGGERS;
  const acceptanceRate = counted.length ? accepted.length / counted.length : null;
  const medianMinutes = median(minutes);
  const urgentUnassigned = unassigned.filter(r => r.hoursToAppointment != null && r.hoursToAppointment <= T.unassignedWithinHours);
  const noEaserCancellations = cancellations.filter(r => r.noEaserTookIt);
  const triggers = [
    { key: 'acceptance', label: 'Offer acceptance below 60%', fired: counted.length >= T.minOffersForRate && acceptanceRate < T.minAcceptanceRate,
      detail: counted.length ? `${accepted.length} of ${counted.length} answered or lapsed offers accepted` : 'No answered or lapsed offers yet' },
    { key: 'assignment_time', label: 'Median time to assignment above 60 minutes', fired: minutes.length >= T.minAssignmentsForMedian && medianMinutes > T.maxMedianMinutesToAssign,
      detail: minutes.length ? `Median ${medianMinutes} min over ${minutes.length} assigned bookings` : 'No assigned bookings in the window' },
    { key: 'urgent_unassigned', label: 'A confirmed job is unassigned within 24 hours of its appointment', fired: urgentUnassigned.length > 0,
      detail: `${urgentUnassigned.length} booking(s)` },
    { key: 'no_easer_cancellation', label: 'A booking was cancelled before any Easer accepted it', fired: noEaserCancellations.length > 0,
      detail: `${noEaserCancellations.length} booking(s) in the window` },
    { key: 'daily_cap', label: `An Easer reached the ${dailyCap}-jobs-per-day dispatch limit`, fired: capHits.length > 0,
      detail: `${capHits.length} Easer-day(s)` },
    { key: 'load', label: 'More than 5 confirmed jobs a week per ready Easer', fired: perEaserWeek != null && perEaserWeek > T.maxWeeklyBookingsPerEaser,
      detail: readyEasers.length ? `${confirmedLastWeek} confirmed in 7 days, ${readyEasers.length} ready Easer(s)` : `${confirmedLastWeek} confirmed in 7 days, no ready Easer on record` },
  ];
  // With no ready Easer at all, any confirmed job means supply is the gap.
  if (!readyEasers.length && confirmedLastWeek > 0) triggers.find(t => t.key === 'load').fired = true;

  return {
    market,
    marketLabel: MARKET_LABELS[market] || market,
    zipPrefixes: marketPrefixes(market),
    windowDays,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      bookings: windowed.length,
      confirmed: confirmedEver.length,
      assigned: assignmentRows.length,
      completed: completedJobs.length,
      cancelled: cancellations.length,
      medianMinutesToAssign: medianMinutes,
      slowestTenthMinutesToAssign: percentile(minutes, 0.9),
      offersSent: windowOffers.length,
      offersAccepted: accepted.length,
      offersDeclined: counted.filter(o => o.offer_status === DISPATCH_OFFER_STATUS.DECLINED).length,
      offersExpired: counted.filter(o => o.offer_status === DISPATCH_OFFER_STATUS.EXPIRED).length,
      acceptanceRate,
      firstOfferAcceptanceRate: firstAttempt.size ? [...firstAttempt.values()].filter(Boolean).length / firstAttempt.size : null,
      fulfillmentRate: confirmedEver.length ? completedJobs.length / confirmedEver.length : null,
      unassignedNow: unassigned.length,
      manualFlaggedNow: manualFlagged.length,
      readyEasers: readyEasers.length,
      easersOnRecord: easers.length,
    },
    assignments: assignmentRows,
    unassigned,
    manualFlagged,
    cancellations,
    completedJobs,
    triggers,
    recruitmentNeeded: triggers.some(t => t.fired),
  };
}
