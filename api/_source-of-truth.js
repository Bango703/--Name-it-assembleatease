// Phase 1 foundation: central business constants shared across API handlers.

export const BOOKING_STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  EN_ROUTE: 'en_route',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DECLINED: 'declined',
  REFUNDED: 'refunded',
});

export const DISPATCH_OFFER_STATUS = Object.freeze({
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  SUPERSEDED: 'superseded',
});

// A booking may enter automatic or owner-triggered dispatch only when the
// customer payment is protected. Captured is intentionally excluded: capture
// belongs after completion, so a non-terminal captured booking needs review.
export const DISPATCH_PAYMENT_STATUSES = Object.freeze([
  'authorized',
  'deposit_paid',
]);

export function isBookingPaymentReadyForDispatch(booking = {}, {
  vercelEnv = process.env.VERCEL_ENV,
} = {}) {
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at
      || booking.financial_reconciliation_required_at
      || booking.cancellation_reconciliation_required_at) return false;
  const disputeStatus = String(booking.stripe_dispute_status || '').toLowerCase();
  if (booking.stripe_dispute_id && !['won', 'warning_closed', 'prevented'].includes(disputeStatus)) return false;
  const totalCents = Number(booking.total_price || 0);
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    return totalCents === 0
      && vercelEnv !== 'production'
      && booking.confirmed_by === 'owner_zero_dollar_simulation';
  }

  const paymentStatus = String(booking.payment_status || '');
  if (!DISPATCH_PAYMENT_STATUSES.includes(paymentStatus)) return false;
  if (paymentStatus === 'authorized') return !!booking.stripe_payment_intent_id;

  const depositCents = Number(booking.deposit_amount || 0);
  return paymentStatus === 'deposit_paid'
    && Number.isInteger(depositCents)
    && depositCents > 0
    && depositCents <= totalCents
    && !!(booking.stripe_deposit_intent_id || booking.stripe_payment_intent_id);
}

export const ACTIVE_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.CONFIRMED,
  BOOKING_STATUS.EN_ROUTE,
  BOOKING_STATUS.ARRIVED,
  BOOKING_STATUS.IN_PROGRESS,
]);

export const VISIBLE_ASSIGNMENT_STATUSES = Object.freeze([
  ...ACTIVE_BOOKING_STATUSES,
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.DECLINED,
  BOOKING_STATUS.REFUNDED,
]);

export const TERMINAL_BOOKING_STATUSES = Object.freeze([
  BOOKING_STATUS.COMPLETED,
  BOOKING_STATUS.CANCELLED,
  BOOKING_STATUS.DECLINED,
  BOOKING_STATUS.REFUNDED,
]);

export const EASER_STAGE = Object.freeze({
  EN_ROUTE: 'en_route',
  ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
});

export const EASER_STAGE_TO_STATUS = Object.freeze({
  [EASER_STAGE.EN_ROUTE]: BOOKING_STATUS.EN_ROUTE,
  [EASER_STAGE.ARRIVED]: BOOKING_STATUS.ARRIVED,
  [EASER_STAGE.IN_PROGRESS]: BOOKING_STATUS.IN_PROGRESS,
});

export const MEMBERSHIP_PLATFORM_FEE_PCT = Object.freeze({
  MEMBER: 25,
  NON_MEMBER: 30,
});

export const NEW_CUSTOMER_OFFER = Object.freeze({
  code: 'WELCOME25',
  discountCents: 2500,
  label: '$25 off your first booking',
  title: 'New Customer Offer',
});

export function getPlatformFeePct(isMember) {
  return isMember ? MEMBERSHIP_PLATFORM_FEE_PCT.MEMBER : MEMBERSHIP_PLATFORM_FEE_PCT.NON_MEMBER;
}

export function normalizePlatformFeePct(feePct, isMember = false) {
  const parsed = Number(feePct);
  return parsed === MEMBERSHIP_PLATFORM_FEE_PCT.MEMBER || parsed === MEMBERSHIP_PLATFORM_FEE_PCT.NON_MEMBER
    ? parsed
    : getPlatformFeePct(isMember);
}

// ── Sales tax ────────────────────────────────────────────────────────────────
// Texas sales tax rate (8.25%). Tax is a PASS-THROUGH LIABILITY owed to the state —
// it is NEVER platform revenue and must be excluded from the platform fee and the
// Easer payout base. Online bookings and customer-approved custom quotes store
// the exact server-calculated tax in bookings.tax_amount.
export const SALES_TAX_RATE = 0.0825;

// ── Same-day service fee ─────────────────────────────────────────────────────
// A premium the customer pays when the appointment is TODAY. It is an ADDITIVE
// layer: it NEVER enters computeBookingSplit's 30/70 base. Of the fee the Easer
// receives a fixed rush bonus and the business keeps the remainder; both are
// stored on the booking (same_day_fee_cents, same_day_easer_bonus_cents).
export const SAME_DAY_FEE_CENTS = 6900;          // $69.00 charged to the customer
/**
 * How long an Easer's earnings are held after completion before the payout is
 * released. The window exists so a dispute or damage claim can surface while
 * the money is still recoverable.
 *
 * Lowered from 48 to 24 hours on 2026-08-29 at the owner's direction: getting
 * paid quickly is what keeps supply, and supply is the platform's constraint.
 * It halves the recovery window, which is a deliberate trade, not an oversight.
 *
 * ONE constant, because the cron and the message an Easer reads were separate
 * numbers before this. The cron released after 48 hours and complete.js told
 * them "about 48 hours" from a hardcoded string — change one and the other
 * quietly lies. Every surface derives from here.
 *
 * Override with PAYOUT_HOLD_HOURS (set to 0 in tests to release immediately).
 */
export const PAYOUT_HOLD_HOURS = Number.isFinite(parseFloat(process.env.PAYOUT_HOLD_HOURS))
  ? parseFloat(process.env.PAYOUT_HOLD_HOURS)
  : 24;

export const SAME_DAY_EASER_BONUS_CENTS = 3000;  // $30.00 rush bonus to the fulfiller
export const SAME_DAY_MIN_LEAD_MINUTES = 180;    // a today slot must start >= 3h from now

export function isSameDayServiceEnabled() {
  return String(process.env.SAME_DAY_ENABLED || '').toLowerCase() === 'true';
}

// yyyy-mm-dd for "today" in America/Chicago (the booking service timezone).
export function chicagoDateIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

// True when the appointment's calendar date is today in America/Chicago.
export function isSameDayAppointment(isoDate, now = new Date()) {
  return typeof isoDate === 'string' && isoDate.slice(0, 10) === chicagoDateIso(now);
}

// Server-authoritative same-day fee for an appointment: full fee only when the
// feature is enabled AND the date is today; otherwise 0. The browser never sets
// this — the server decides from the appointment date.
export function sameDayFeeForAppointment(isoDate, now = new Date()) {
  return isSameDayServiceEnabled() && isSameDayAppointment(isoDate, now)
    ? SAME_DAY_FEE_CENTS
    : 0;
}

/**
 * THE canonical money split for a priced booking. Every surface — completion,
 * payout, dashboard, estimate, email — must derive earnings from this so the
 * whole platform shares one financial truth.
 *
 *   total  = amount charged to the customer (tax-inclusive)
 *   tax    = pass-through liability (from booking.tax_amount; 0 if none)
 *   base   = total - tax                       (what platform + Easer split)
 *   fee    = base * platformFeePct             (platform commission)
 *   payout = base - fee                        (Easer earnings, assembler_due)
 *
 * @param {number}  totalInclusiveCents
 * @param {boolean} isMember
 * @param {{taxCents?: number}} opts  stored booking.tax_amount (default 0)
 * @returns {{ totalCents, taxCents, revenueBaseCents, feePct, platformFeeCents, assemblerDueCents }}
 */
export function computeBookingSplit(totalInclusiveCents, isMember, { taxCents = 0 } = {}) {
  const total = Math.max(0, Math.round(Number(totalInclusiveCents) || 0));
  const tax   = Math.min(total, Math.max(0, Math.round(Number(taxCents) || 0)));
  const revenueBase  = total - tax;
  const feePct       = getPlatformFeePct(isMember);
  const platformFee  = Math.round(revenueBase * feePct / 100);
  const assemblerDue = revenueBase - platformFee;
  return {
    totalCents:        total,
    taxCents:          tax,
    revenueBaseCents:  revenueBase,
    feePct,
    platformFeeCents:  platformFee,
    assemblerDueCents: assemblerDue,
  };
}

export function computeBookingSplitAtFeePct(totalInclusiveCents, feePct, { taxCents = 0 } = {}) {
  const total = Math.max(0, Math.round(Number(totalInclusiveCents) || 0));
  const tax = Math.min(total, Math.max(0, Math.round(Number(taxCents) || 0)));
  const revenueBase = total - tax;
  const canonicalFeePct = normalizePlatformFeePct(feePct);
  const platformFee = Math.round(revenueBase * canonicalFeePct / 100);
  return {
    totalCents: total,
    taxCents: tax,
    revenueBaseCents: revenueBase,
    feePct: canonicalFeePct,
    platformFeeCents: platformFee,
    assemblerDueCents: revenueBase - platformFee,
  };
}

/**
 * Compute the payout split from a stored booking snapshot. Use this when a
 * platform-funded credit (for example AssembleCash) reduced what the customer
 * paid but must NOT reduce the Easer's payout basis.
 *
 * @param {{
 *   amountChargedCents?: number|null,
 *   totalPriceCents?: number|null,
 *   taxCents?: number,
 *   isMember?: boolean,
 *   feePct?: number|null,
 *   assemblecashRedeemedCents?: number,
 * }} args
 * @returns {{
 *   totalCents: number,
 *   taxCents: number,
 *   pretaxCollectedCents: number,
 *   payoutBaseCents: number,
 *   feePct: number,
 *   protectedPlatformFeeCents: number,
 *   platformFeeCents: number,
 *   assemblerDueCents: number,
 *   assemblecashRedeemedCents: number,
 * }}
 */
export function computeBookingSplitFromSnapshot({
  amountChargedCents = null,
  totalPriceCents = null,
  taxCents = 0,
  isMember = false,
  feePct = null,
  assemblecashRedeemedCents = 0,
} = {}) {
  const chargedRaw = amountChargedCents != null ? amountChargedCents : totalPriceCents;
  const total = Math.max(0, Math.round(Number(chargedRaw) || 0));
  const tax = Math.min(total, Math.max(0, Math.round(Number(taxCents) || 0)));
  const redeemed = Math.max(0, Math.round(Number(assemblecashRedeemedCents) || 0));
  const pretaxCollected = total - tax;
  const payoutBase = pretaxCollected + redeemed;
  const canonicalFeePct = normalizePlatformFeePct(feePct, isMember);
  const protectedPlatformFee = Math.round(payoutBase * canonicalFeePct / 100);
  const assemblerDue = payoutBase - protectedPlatformFee;
  const platformFee = pretaxCollected - assemblerDue;

  return {
    totalCents: total,
    taxCents: tax,
    pretaxCollectedCents: pretaxCollected,
    payoutBaseCents: payoutBase,
    feePct: canonicalFeePct,
    protectedPlatformFeeCents: protectedPlatformFee,
    platformFeeCents: platformFee,
    assemblerDueCents: assemblerDue,
    assemblecashRedeemedCents: redeemed,
  };
}

// ─── Cancellation policy ─────────────────────────────────────────────────────
// Tiered cancellation fee as a % of the PRE-TAX SERVICE SUBTOTAL (labor only —
// NEVER tax, never the service-call fee). Free with reasonable notice; a fair,
// capped fee for late cancels; a higher fee once a pro is committed or for a
// no-show — but NEVER 100% (no work was performed). Server is the source of
// truth; never trust a client-sent fee.
export const CANCELLATION_POLICY = Object.freeze({
  freeWindowHours: 24,     // 24h+ before the appointment → free
  imminentWindowHours: 2,  // under 2h before, pro en route/arrived/in-progress, or no-show
  lateFeePct: 10,          // within 24h, pro not yet en route
  imminentFeePct: 15,      // imminent / en route / no-show
});

/**
 * Compute the cancellation fee on the pre-tax service subtotal.
 * Derive serviceSubtotalCents as total_price - tax_amount - service_call_fee.
 * @param {{ serviceSubtotalCents?:number, hoursUntilAppointment?:(number|null), status?:(string|null), isNoShow?:boolean, forfeitFreeWindow?:boolean }} args
 * @returns {{ tier:('free'|'late'|'imminent'), feePct:number, feeCents:number, proTripCut:boolean }}
 */
export function computeCancellationFee({ serviceSubtotalCents = 0, hoursUntilAppointment = null, status = null, isNoShow = false, forfeitFreeWindow = false, easerAccepted = false } = {}) {
  const sub = Math.max(0, Math.round(Number(serviceSubtotalCents) || 0));
  const h = (typeof hoursUntilAppointment === 'number' && isFinite(hoursUntilAppointment)) ? hoursUntilAppointment : null;

  // ── HARD INVARIANT: no accepted Easer, no customer cancellation fee ────────
  //
  // A cancellation fee compensates a committed pro for a slot they can no longer
  // fill. If nobody ever accepted the job, there is no commitment, no lost slot,
  // and nothing to compensate — the platform simply failed to supply, and
  // charging the customer for that failure is indefensible.
  //
  // This is not hypothetical. AAE-LYTX3WIQW3 was assigned three times, accepted
  // by nobody, still unassigned twenty-three minutes before the customer's window
  // closed, and the customer was charged $32.94 to cancel a job no one was ever
  // coming to. This rule exists so that cannot happen again.
  //
  // Tested on ACCEPTANCE rather than assignment, deliberately: that booking DID
  // carry an assembler_id at points, and an assignment nobody agreed to is not a
  // commitment. It also defaults to false, so a caller that forgets to pass it
  // fails toward not charging. Losing a fee we were owed is recoverable; taking
  // money we were not owed is not.
  if (easerAccepted !== true) {
    return { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false, waivedReason: 'no_easer_accepted' };
  }

  const proCommitted = status === BOOKING_STATUS.EN_ROUTE || status === BOOKING_STATUS.ARRIVED || status === BOOKING_STATUS.IN_PROGRESS;

  let tier, feePct;
  if (isNoShow || proCommitted || (h != null && h < CANCELLATION_POLICY.imminentWindowHours)) {
    tier = 'imminent'; feePct = CANCELLATION_POLICY.imminentFeePct;
  } else if (h != null && h < CANCELLATION_POLICY.freeWindowHours) {
    tier = 'late'; feePct = CANCELLATION_POLICY.lateFeePct;
  } else {
    tier = 'free'; feePct = 0;
  }
  // A rescheduled booking forfeits its free window — at minimum the late tier applies.
  if (forfeitFreeWindow && tier === 'free') { tier = 'late'; feePct = CANCELLATION_POLICY.lateFeePct; }

  return { tier, feePct, feeCents: Math.round(sub * feePct / 100), proTripCut: tier === 'imminent' };
}

/**
 * Estimated Stripe processing fee (2.9% + $0.30). This is an ESTIMATE for
 * projections only — the authoritative fee comes from the Stripe balance
 * transaction at capture. One canonical estimator so the rate never diverges.
 */
export function estimateStripeFeeCents(chargeCents) {
  const c = Math.round(Number(chargeCents) || 0);
  return c > 0 ? Math.round(c * 0.029) + 30 : 0;
}

/**
 * Canonical owner-facing financial summary for a captured booking.
 * Tax is proportionally reversed with refunds and never treated as platform
 * revenue. Easer cost is the actual payout when recorded, otherwise the
 * booking's outstanding earnings liability. Stripe's recorded fee wins over
 * the estimator because Stripe is financial truth after capture.
 */
export function computeBookingFinancialSummary({
  amountChargedCents = 0,
  totalPriceCents = 0,
  refundAmountCents = 0,
  taxAmountCents = 0,
  stripeFeeCents = null,
  assemblerDueCents = 0,
  payoutAmountCents = 0,
  // Owner-funded bonus. Counted as an Easer cost from the moment it is
  // promised, not from when it is paid — otherwise the margin looks
  // healthier than it is for every job sitting between the two.
  easerBonusCents = 0,
} = {}) {
  const grossChargedCents = Math.max(0, Math.round(Number(amountChargedCents || totalPriceCents) || 0));
  const refundedCents = Math.min(grossChargedCents, Math.max(0, Math.round(Number(refundAmountCents) || 0)));
  const netChargedCents = Math.max(0, grossChargedCents - refundedCents);
  const originalTaxCents = Math.min(grossChargedCents, Math.max(0, Math.round(Number(taxAmountCents) || 0)));
  const taxCollectedCents = grossChargedCents > 0
    ? Math.min(netChargedCents, Math.round(originalTaxCents * netChargedCents / grossChargedCents))
    : 0;
  const recordedStripeFee = Number(stripeFeeCents);
  const processingFeeCents = stripeFeeCents != null && Number.isFinite(recordedStripeFee)
    ? Math.max(0, Math.round(recordedStripeFee))
    : estimateStripeFeeCents(netChargedCents);
  const payoutRecorded = Math.max(0, Math.round(Number(payoutAmountCents) || 0));
  const bonusCents = Math.max(0, Math.round(Number(easerBonusCents) || 0));
  // A recorded payout already includes the bonus (both rails add it before
  // paying), so it is only added to the un-paid estimate.
  const easerCostCents = payoutRecorded > 0
    ? payoutRecorded
    : Math.max(0, Math.round(Number(assemblerDueCents) || 0)) + bonusCents;

  return {
    grossChargedCents,
    refundedCents,
    netChargedCents,
    taxCollectedCents,
    processingFeeCents,
    processingFeeIsActual: stripeFeeCents != null && Number.isFinite(recordedStripeFee),
    easerCostCents,
    easerBonusCents: bonusCents,
    // What the platform actually kept before processing costs — DERIVED, never
    // the stored bookings.platform_fee column. That column is a snapshot of the
    // 30% commission at completion time, and a later goodwill discount does not
    // update it: the discount RPC deliberately preserves the Easer's earnings
    // and lets the platform absorb the reduction, so the stored fee keeps
    // claiming a commission the platform no longer took. Deriving it here means
    // the booking panel and the financial dashboard can never disagree about
    // the same job (Article 2).
    platformFeeCents: netChargedCents - taxCollectedCents - easerCostCents,
    platformGrossCents: netChargedCents - taxCollectedCents - processingFeeCents - easerCostCents,
  };
}

// Owner-created bookings can be collected in multiple verified payments. Until
// the invoice is fully satisfied, only the proportional share of sales tax has
// actually been collected. Keeping this allocation in one helper prevents the
// owner booking detail, tax report, and finance dashboard from disagreeing.
export function allocateCollectedTaxCents({
  invoiceTotalCents = 0,
  invoiceTaxCents = 0,
  grossCollectedCents = 0,
} = {}) {
  const invoiceTotal = Math.max(0, Math.round(Number(invoiceTotalCents) || 0));
  const invoiceTax = Math.min(invoiceTotal, Math.max(0, Math.round(Number(invoiceTaxCents) || 0)));
  const grossCollected = Math.max(0, Math.round(Number(grossCollectedCents) || 0));
  if (!invoiceTotal || !invoiceTax || !grossCollected) return 0;
  return Math.min(
    grossCollected,
    Math.round(invoiceTax * Math.min(grossCollected, invoiceTotal) / invoiceTotal),
  );
}

// isTexasZip covers the whole state and gates statewide instant booking. A job
// far from any Easer is not blocked at booking — it is prevented from
// auto-dispatching (see isAutomaticDispatchZip) and waits for owner assignment.
export const TEXAS_ZIP_PREFIXES = Object.freeze(['733', '885']);
export const TEXAS_ZIP_PREFIX_RANGE = Object.freeze({ min: 750, max: 799 });

export function isTexasZip(zip) {
  const normalized = String(zip || '').trim();
  if (!/^\d{5}$/.test(normalized)) return false;
  const prefix = normalized.slice(0, 3);
  const numericPrefix = Number(prefix);
  return TEXAS_ZIP_PREFIXES.includes(prefix)
    || (numericPrefix >= TEXAS_ZIP_PREFIX_RANGE.min && numericPrefix <= TEXAS_ZIP_PREFIX_RANGE.max);
}

export const AUTOMATIC_DISPATCH_ZIP_PREFIXES = Object.freeze(['787']);
export const AUTOMATIC_DISPATCH_ZIPS = Object.freeze([
  '78610', '78613', '78626', '78628', '78630', '78633', '78634',
  '78640', '78641', '78645', '78646', '78653', '78660', '78664',
  '78665', '78680', '78681', '78682', '78683', '78691',
]);
// Instant booking is open statewide: any valid Texas ZIP may book. This is safe
// only because auto-dispatch is deliberately NOT statewide — see
// isAutomaticDispatchZip below. A booking outside the auto-dispatch area is
// written with needs_manual_dispatch=true (api/booking.js), which BOTH the
// auto-dispatch cron and the dispatch engine refuse to act on, so a far-market
// job can never be blasted to an Austin Easer. It authorizes the card (a hold,
// not a charge) and waits for the owner to assign or cancel.
//
// DO NOT widen isAutomaticDispatchZip to match this. Auto-dispatch staying
// narrow is the safety mechanism that makes statewide booking safe.
export const ACTIVE_INSTANT_BOOKING_ZIP_PREFIXES = Object.freeze([
  ...TEXAS_ZIP_PREFIXES,
  ...Array.from({ length: 50 }, (_, index) => String(750 + index)),
]);
export const ACTIVE_INSTANT_BOOKING_ZIPS = Object.freeze([]);

export function isActiveInstantBookingZip(zip) {
  return isTexasZip(zip);
}

export function isAutomaticDispatchZip(zip) {
  const normalized = String(zip || '').trim();
  if (!/^\d{5}$/.test(normalized)) return false;
  return AUTOMATIC_DISPATCH_ZIP_PREFIXES.includes(normalized.slice(0, 3))
    || AUTOMATIC_DISPATCH_ZIPS.includes(normalized);
}

// Service-call fee — FLAT $5 across all Texas booking zones.
// Server classification remains authoritative; the browser check is convenience only.
export const SERVICE_CALL_ZONES = Object.freeze({
  austin_core:    { label: 'Austin core', fee: 500 },
  near_suburb:    { label: 'Participating Central Texas communities', fee: 500 },
  texas_statewide: { label: 'Statewide Texas service', fee: 500 },
});

// Launch profit guardrails. These are pre-tax service-revenue floors, so sales
// tax can never make a weak job look profitable. Quote requests are exempt.
export const MIN_PRETAX_BOOKING_BY_ZONE = Object.freeze({
  austin_core: 12900,
  near_suburb: 14900,
  texas_statewide: 14900,
});

export function getMinimumPretaxBookingCents(zone) {
  return MIN_PRETAX_BOOKING_BY_ZONE[zone] || null;
}

export function getServiceCallZone(zip) {
  if (!isTexasZip(zip)) return null;
  const prefix = String(zip || '').trim().slice(0, 3);
  if (prefix === '787') return 'austin_core';
  if (isAutomaticDispatchZip(zip)) return 'near_suburb';
  return 'texas_statewide';
}

export function getServiceCallFeeCents(zip) {
  const zone = getServiceCallZone(zip);
  return zone ? SERVICE_CALL_ZONES[zone].fee : null;
}

export function isActiveBookingStatus(status) {
  return ACTIVE_BOOKING_STATUSES.includes(status);
}

export function isTerminalBookingStatus(status) {
  return TERMINAL_BOOKING_STATUSES.includes(status);
}
