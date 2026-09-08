import {
  BOOKING_STATUS,
  TERMINAL_BOOKING_STATUSES,
  isTerminalBookingStatus,
} from './_source-of-truth.js';

/**
 * _stranded-bookings-core.js — the ONE answer to "which real bookings is nobody
 * working on".
 *
 * WHAT GOES WRONG
 * A customer submits and pays. If the payment does not complete, the booking
 * stays `pending`, dispatch is paused, and no Easer is ever offered the job.
 * The customer sees a booking they believe is happening. The owner is told
 * nothing.
 *
 * Every cron that hunts for stranded work filters `status = 'confirmed'`:
 * auto-dispatch, expire-offers, unassigned-escalation, stale-booking,
 * reminders, no-show-check, reauth-payments. A booking that never reaches
 * `confirmed` is outside all of them. The one cron that reads `pending` is
 * stripe-reconciliation, and it compares money against Stripe — it has no
 * opinion about whether anyone is doing the work.
 *
 * It is not hypothetical. On 2026-08-18 the same customer submitted three
 * outdoor/playset bookings at $329.08 each, four minutes apart — the pattern of
 * someone retrying because nothing is happening. All three sat at
 * dispatch_status `payment_hold`, were never assigned to anyone, and were
 * cancelled four days later. On 2026-08-27 a $243.13 fitness booking reached
 * `manual_required`, was never assigned, and the customer cancelled it himself
 * the next day. That is $1,230 of demand that arrived and was never shown to a
 * single Easer, on a platform with four completed jobs.
 *
 * WHY IT CATCHES BY DEFAULT
 * The obvious rule is "alert when status is pending". That repeats the original
 * mistake: it names the states it knows about, so the next state anyone adds
 * falls through the same crack. This inverts it. A booking is stranded unless
 * it is terminal, or assigned, or in a state another watcher demonstrably owns.
 * Anything new is caught until someone deliberately excludes it.
 *
 * IT NEVER WRITES. Detection only. Nothing here changes a booking, a payment,
 * or a dispatch — a report that quietly mutates money is worse than no report.
 */

// `confirmed` and everything after it belong to unassigned-escalation,
// auto-dispatch and expire-offers. Listing them here is what keeps this from
// double-alerting on work those crons already chase.
export const WATCHED_ELSEWHERE = Object.freeze([
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.EN_ROUTE,
  BOOKING_STATUS.ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
]);

// How long a booking may sit unassigned before it counts as stranded. Dispatch
// fires immediately on confirmation and offers run on a 20-minute TTL, so 45
// minutes is comfortably past "still working normally" without being so long
// that a customer has already given up.
export const STRANDED_AFTER_MINUTES = 45;

/** Is this booking outside every other watcher, with nobody working on it? */
export function isStranded(booking, { now = Date.now(), minutes = STRANDED_AFTER_MINUTES } = {}) {
  if (!booking) return false;
  const status = String(booking.status || '').toLowerCase();

  // Finished, cancelled or refunded: nothing owed to anyone.
  if (isTerminalBookingStatus(status)) return false;
  // Someone has it.
  if (booking.assembler_id) return false;
  // Another cron owns this state and is already chasing it.
  if (WATCHED_ELSEWHERE.includes(status)) return false;

  const createdAt = Date.parse(booking.created_at || '');
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt >= minutes * 60 * 1000;
}

/** Plain-language reason, for an owner who should not have to read a schema. */
export function strandedReason(booking) {
  const payment = String(booking?.payment_status || '').toLowerCase();
  const dispatch = String(booking?.dispatch_status || '').toLowerCase();

  if (dispatch === 'payment_hold' || payment === 'failed') {
    return 'The payment did not complete, so dispatch was paused and no Easer was ever offered this job.';
  }
  if (payment === 'authorization_released') {
    return 'The card authorization was released before the job was dispatched. No Easer was ever offered it.';
  }
  if (dispatch === 'manual_required' || booking?.needs_manual_dispatch) {
    return 'Automatic dispatch gave up and flagged this for manual assignment. It is still unassigned.';
  }
  if (booking?.dispatch_paused) {
    return 'Dispatch is paused on this booking and no Easer has been assigned.';
  }
  return 'This booking never reached confirmed and no Easer has been assigned.';
}

/**
 * Every stranded booking, newest first. Reads only.
 *
 * @param {object} sb      Supabase client.
 * @param {object} options `now`, `minutes`, `limit`.
 */
export async function findStrandedBookings(sb, { now = Date.now(), minutes = STRANDED_AFTER_MINUTES, limit = 50 } = {}) {
  const { data, error } = await sb
    .from('bookings')
    .select('id, ref, status, service, date, time, total_price, customer_name, customer_email, customer_phone, '
      + 'assembler_id, payment_status, dispatch_status, dispatch_paused, needs_manual_dispatch, source, created_at')
    .not('status', 'in', `(${TERMINAL_BOOKING_STATUSES.join(',')})`)
    .is('assembler_id', null)
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) throw new Error(`stranded booking lookup failed: ${error.message || error}`);

  return (data || [])
    .filter(b => isStranded(b, { now, minutes }))
    .map(b => ({
      ...b,
      strandedReason: strandedReason(b),
      minutesStranded: Math.round((now - Date.parse(b.created_at)) / 60000),
    }));
}
