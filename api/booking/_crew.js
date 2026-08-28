import { computeBookingSplitFromSnapshot } from '../_source-of-truth.js';
import { readinessError } from '../_easer-readiness.js';

/**
 * THE crew module. Who is on a booking, and what each person earns.
 *
 * WHY IT EXISTS
 * bookings.assembler_id answers "who is on this job" in 276 places across 63
 * files. The moment a second person can be on a job, that question has a
 * different answer, and 276 call sites cannot each be taught the new rule —
 * that is precisely how "two places holding one fact" happens (Article 1).
 *
 * So the rule lives here, once:
 *   - assembler_id remains the LEAD. It is not deprecated, not widened, not
 *     shadowed. Dispatch, acceptance, completion, and acceptance-rate all
 *     continue to key off it, unchanged.
 *   - booking_crew answers "who else", and what each person is owed.
 *   - Every assigned booking has a lead crew row (migration 077 backfills them),
 *     so there is never a "does this booking use crew?" branch.
 *
 * THIS MODULE NEVER WRITES. It loads, it computes, it decides eligibility. The
 * handler performs the write and the RPC owns the money, so there is exactly one
 * transactional path per financial fact (Article 5).
 */

export const CREW_ROLE = Object.freeze({
  LEAD: 'lead',
  HELPER: 'helper',
});

export const CREW_PAYOUT_STATUS = Object.freeze({
  OWED: 'owed',
  PAID: 'paid',
  VOID: 'void',
});

/**
 * Whose money paid this person. This is not bookkeeping trivia: it is the
 * difference between a labor cost and a margin write-off, and the financial
 * dashboard cannot tell contribution from loss without it.
 */
export const CREW_FUNDING = Object.freeze({
  /** Split out of the existing Easer pool. Platform margin unchanged. */
  LABOR_POOL: 'labor_pool',
  /** The customer approved and paid for extra scope. */
  CHANGE_ORDER: 'change_order',
  /**
   * HISTORICAL ONLY — the platform absorbing a helper's pay out of margin.
   * Migration 077's CHECK constraint still permits the value so old rows stay
   * readable, but no new row may be written with it. See ALLOWED_NEW_FUNDING.
   */
  PLATFORM_MARGIN: 'platform_margin',
});

/**
 * What may fund a crew member being added TODAY.
 *
 * The owner's ruling, and it is a pricing rule rather than a payments one:
 * "If a job requires 2 people then the cost of the job is not enough. The owner
 * will not take a loss."
 *
 * On a $280 job the platform keeps $77.60. A $60 helper leaves $17.60 — six
 * percent. Funding crew from margin turns a mispriced service into a silent,
 * per-job write-off that never shows up as the pricing problem it actually is.
 * So there are exactly two honest sources: divide the pay the job already
 * carries, or have the customer approve and pay for the extra scope.
 */
export const ALLOWED_NEW_FUNDING = Object.freeze([
  CREW_FUNDING.LABOR_POOL,
  CREW_FUNDING.CHANGE_ORDER,
]);

export function fundingIsAllowedForNewCrew(funding) {
  return ALLOWED_NEW_FUNDING.includes(funding);
}

/** Statuses after which adding crew creates a NEW obligation rather than a split. */
const PAYOUT_SETTLED = new Set(['paid', 'partial']);

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * THE crew loader. Every consumer reads through this so no handler grows its own
 * inline query with its own idea of which rows count.
 *
 * Removed rows are excluded by default — they are audit history, not crew.
 *
 * @returns {Promise<Map<string, Array>>} bookingId -> crew rows, lead first
 */
export async function loadCrew(bookingIds, { sb, includeRemoved = false } = {}) {
  const ids = [...new Set((Array.isArray(bookingIds) ? bookingIds : [bookingIds]).filter(Boolean))];
  const byBooking = new Map(ids.map(id => [id, []]));
  if (!ids.length || !sb) return byBooking;

  let query = sb
    .from('booking_crew')
    .select('id, booking_id, easer_id, role, due_cents, fee_pct_snapshot, funded_from, payout_status, added_by, added_reason, added_at, removed_at, removed_reason')
    .in('booking_id', ids);
  if (!includeRemoved) query = query.is('removed_at', null);

  const { data, error } = await query;
  if (error) {
    // A crew lookup failure must not blank out a booking view. Callers get empty
    // crew and the booking still renders from assembler_id.
    console.error('[crew] load failed:', error?.message || error);
    return byBooking;
  }

  for (const row of data || []) {
    if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, []);
    byBooking.get(row.booking_id).push(row);
  }
  for (const rows of byBooking.values()) {
    rows.sort((a, b) => {
      if (a.role !== b.role) return a.role === CREW_ROLE.LEAD ? -1 : 1;
      return String(a.added_at || '').localeCompare(String(b.added_at || ''));
    });
  }
  return byBooking;
}

// ── Access ──────────────────────────────────────────────────────────────────

/**
 * Is this user on this booking? Replaces the hand-written
 * `booking.assembler_id !== user.id` gate at every Easer route.
 *
 * Falls back to assembler_id when crew is unavailable, so a crew-table outage
 * degrades to today's behaviour rather than locking the lead out of their own
 * job. It can only ever GRANT what the old check granted, never less.
 */
export function easerIsOnBooking(booking, crew, userId) {
  if (!userId) return false;
  if (booking?.assembler_id && booking.assembler_id === userId) return true;
  return (crew || []).some(row => row.easer_id === userId && !row.removed_at);
}

/**
 * Completion, capture, and status transitions stay with the LEAD alone.
 *
 * Not a limitation — a deliberate one. Capture is guarded by a single
 * financial_operation_key; letting two people race to complete the same job is
 * how a double capture or a lost reservation happens. Helpers upload evidence
 * and message; exactly one person ends the job.
 */
export function easerMayCompleteBooking(booking, userId) {
  return Boolean(userId && booking?.assembler_id === userId);
}

export function crewRoleFor(booking, crew, userId) {
  if (booking?.assembler_id === userId) return CREW_ROLE.LEAD;
  const row = (crew || []).find(r => r.easer_id === userId && !r.removed_at);
  return row ? row.role : null;
}

// ── Money ───────────────────────────────────────────────────────────────────

/**
 * The labor pool for a booking — the whole amount available to pay people,
 * before it is divided. Reads the canonical split so the crew can never invent
 * its own fee maths.
 */
export function laborPoolCents(booking) {
  if (!booking) return 0;
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: booking.amount_charged ?? null,
    totalPriceCents: booking.total_price ?? null,
    taxCents: booking.tax_amount || 0,
    feePct: booking.easer_fee_pct_snapshot ?? null,
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  return Math.max(0, split.assemblerDueCents || 0);
}

/**
 * Propose how the pool divides once `addingCount` more people join.
 *
 * PROPOSES. Does not apply. The caller shows this to the owner and the owner
 * confirms, because of one fact that outranks convenience:
 *
 *   The lead's earnings were snapshotted when they accepted
 *   (easer_estimated_due_snapshot). Splitting the pool automatically would
 *   silently reduce a number already promised to a contractor. Rule 10 says an
 *   Easer must always know what they will earn; Article 16 says the UI must
 *   never assert what it has not verified. So the reduction is computed, named,
 *   and surfaced — never applied behind the owner's back.
 *
 * Remainder cents go to the lead so the pool always divides exactly and no cent
 * is created or destroyed.
 *
 * @returns {{
 *   poolCents: number,
 *   headcount: number,
 *   perPersonCents: number,
 *   allocations: Array<{ easerId: string|null, role: string, dueCents: number, deltaCents: number }>,
 *   leadReductionCents: number,
 *   reducesExistingPay: boolean,
 * }}
 */
export function proposeEvenSplit({ booking, crew = [], addingCount = 1 } = {}) {
  const pool = laborPoolCents(booking);
  const active = (crew || []).filter(r => !r.removed_at && r.payout_status !== CREW_PAYOUT_STATUS.VOID);
  const headcount = active.length + Math.max(0, addingCount);

  if (headcount <= 0) {
    return { poolCents: pool, headcount: 0, perPersonCents: 0, allocations: [], leadReductionCents: 0, reducesExistingPay: false };
  }

  const perPerson = Math.floor(pool / headcount);
  const remainder = pool - perPerson * headcount;

  const allocations = [];
  let leadReduction = 0;

  for (const row of active) {
    const isLead = row.role === CREW_ROLE.LEAD;
    const due = perPerson + (isLead ? remainder : 0);
    const delta = due - Number(row.due_cents || 0);
    if (isLead && delta < 0) leadReduction = -delta;
    allocations.push({ easerId: row.easer_id, role: row.role, dueCents: due, deltaCents: delta });
  }
  for (let i = 0; i < Math.max(0, addingCount); i += 1) {
    allocations.push({ easerId: null, role: CREW_ROLE.HELPER, dueCents: perPerson, deltaCents: perPerson });
  }

  return {
    poolCents: pool,
    headcount,
    perPersonCents: perPerson,
    allocations,
    leadReductionCents: leadReduction,
    reducesExistingPay: allocations.some(a => a.easerId && a.deltaCents < 0),
  };
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * May this Easer be added to this booking, and how is it funded?
 *
 * The readiness argument is passed in rather than fetched, so this stays pure
 * and the caller uses the ONE canonical getEaserReadiness(). Adding crew must
 * never become a back door around identity verification and the contractor
 * agreement — two unvetted people in a customer's home is the failure this
 * check exists to prevent.
 *
 * @param {object} args
 * @param {object} args.booking
 * @param {Array}  args.crew        Active crew rows.
 * @param {string} args.easerId
 * @param {object} args.readiness   Result of getEaserReadiness() for that Easer.
 * @returns {{ ok: boolean, reason?: string, message?: string, defaultFunding?: string, createsNewObligation?: boolean }}
 */
export function crewEligibility({ booking, crew = [], easerId, readiness } = {}) {
  if (!booking?.id) {
    return { ok: false, reason: 'no_booking', message: 'Booking not found.' };
  }
  if (!easerId) {
    return { ok: false, reason: 'no_easer', message: 'Select an Easer to add.' };
  }
  if (!booking.assembler_id) {
    return {
      ok: false,
      reason: 'no_lead',
      message: 'Assign a lead Easer before adding anyone else to this job.',
    };
  }
  if (booking.assembler_id === easerId || (crew || []).some(r => r.easer_id === easerId && !r.removed_at)) {
    return { ok: false, reason: 'already_on_job', message: 'That Easer is already on this job.' };
  }
  // getEaserReadiness() returns `isReady` + `missingItems`. Reading a `ready`
  // field that does not exist would make every READY Easer look unready, so this
  // uses the canonical shape and the canonical message builder — the same one the
  // dispatch and assignment paths use — rather than inventing a second wording
  // for the same refusal (Article 16).
  if (!readiness || readiness.isReady !== true) {
    return {
      ok: false,
      reason: 'not_ready',
      message: readinessError(readiness) || 'That Easer is not cleared for jobs yet.',
    };
  }
  if (['cancelled', 'declined', 'refunded'].includes(String(booking.status || ''))) {
    return {
      ok: false,
      reason: 'terminal_booking',
      message: `This booking is ${booking.status}. Nobody can be added to it.`,
    };
  }

  // Once a payout is recorded the pool is no longer divisible — somebody has
  // already been handed their share, and money that has left cannot be re-split.
  //
  // The old behaviour here was to fall back to platform_margin. That is exactly
  // the silent write-off the owner ruled out, so this now REFUSES and names the
  // only honest route: the customer approves and pays for the extra scope.
  if (PAYOUT_SETTLED.has(String(booking.payout_status || ''))) {
    return {
      ok: false,
      reason: 'payout_settled',
      message: 'This job\'s Easer pay has already been paid out, so it cannot be re-split. '
        + 'To bring someone else in, raise a change order the customer approves.',
    };
  }

  return { ok: true, defaultFunding: CREW_FUNDING.LABOR_POOL, createsNewObligation: false };
}

/**
 * What each person is left with once the pool is divided.
 *
 * Surfaced because the owner's own rule implies it: if a job needs two people,
 * the job is underpriced. The split is where that becomes visible — $181 is a
 * fair day; $90 each may not be worth either Easer's time, and an Easer who
 * feels underpaid declines the next one. This reports the number rather than
 * inventing a threshold to judge it by.
 */
export function splitPressure({ booking, crew = [], addingCount = 1 } = {}) {
  const proposal = proposeEvenSplit({ booking, crew, addingCount });
  const soloPool = laborPoolCents(booking);
  return {
    perPersonCents: proposal.perPersonCents,
    headcount: proposal.headcount,
    soloPoolCents: soloPool,
    // True whenever a split is happening at all — the owner asked for this to be
    // read as a pricing signal, not a payments one.
    underpricedSignal: proposal.headcount > 1,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** Owner-facing totals for one booking's crew. */
export function summarizeCrew(crew = []) {
  const active = crew.filter(r => !r.removed_at && r.payout_status !== CREW_PAYOUT_STATUS.VOID);
  const owed = active.filter(r => r.payout_status === CREW_PAYOUT_STATUS.OWED);
  return {
    headcount: active.length,
    isCrewJob: active.length > 1,
    totalDueCents: active.reduce((sum, r) => sum + Number(r.due_cents || 0), 0),
    owedCents: owed.reduce((sum, r) => sum + Number(r.due_cents || 0), 0),
    owedCount: owed.length,
    allPaid: active.length > 0 && owed.length === 0,
    fromMarginCents: active
      .filter(r => r.funded_from === CREW_FUNDING.PLATFORM_MARGIN)
      .reduce((sum, r) => sum + Number(r.due_cents || 0), 0),
  };
}
