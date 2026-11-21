// Phase 1 foundation: central business constants shared across API handlers.

// The scheduled-authorization lead time is owned by _booking-window.js; the
// refusal message quotes it rather than restating the number (Article 2).
import { SCHEDULED_AUTHORIZATION_LEAD_DAYS } from './booking/_booking-window.js';
// Service-area distance (serviceAreaCheck): the Census ZIP points and the one
// great-circle formula the platform already uses for arrival checks.
import { TEXAS_ZIP_LOCATIONS } from './_texas-zip-locations.js';
import { distanceMetres } from './_geocode.js';

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

/**
 * WHY the customer's payment is not dispatch-ready, or null when it is.
 *
 * This gate refuses for seven distinct reasons and for a long time said only
 * "Payment is not verified for assignment". An owner hit it while assigning a
 * pro whose payouts were fine, read it as the PRO's payment setup, and went
 * looking in entirely the wrong place. Article 14: a refusal states its reason
 * to the human who hit it. Article 16: never a generic message where a specific
 * one exists.
 *
 * Every message names the CUSTOMER's payment explicitly, because the ambiguity
 * is exactly what misdirected the owner.
 *
 * isBookingPaymentReadyForDispatch is defined in terms of this function, so the
 * check and the explanation are physically incapable of disagreeing (Article 1).
 *
 * @returns {{code:string, message:string}|null}
 */
export function describeDispatchPaymentBlock(booking = {}, {
  vercelEnv = process.env.VERCEL_ENV,
  // OWNER MANUAL ASSIGNMENT ONLY.
  //
  // A booking taken more than IMMEDIATE_AUTHORIZATION_DAYS out is written
  // 'card_saved': the customer's card is confirmed and on file, and the hold is
  // deliberately deferred to SCHEDULED_AUTHORIZATION_LEAD_DAYS before the visit
  // because a Stripe authorization only survives 7 days. That is a SAVED card,
  // not a missing one — unlike 'pending', 'failed' or 'not_required'.
  //
  // Treating it as unpayable meant no advance booking could have an Easer
  // attached until five days before the job. The owner could not line up supply,
  // a pro got at most five days' notice, and the customer had already been told
  // "a pro has already reserved the time" — which nothing in the system could
  // make true.
  //
  // So a confirmed saved card may be STAFFED: offered, assigned and accepted
  // (owner, 2026-10-16: an advance Austin booking sent no offers for days).
  // Staffing paths call describeStaffingPaymentBlock below; work paths (travel,
  // arrival, completion) keep this option off, and DISPATCH_PAYMENT_STATUSES is
  // unchanged.
  //
  // Money is unaffected either way. Completion and capture are gated separately
  // in assembler-complete.js, which refuses anything that is not authorized,
  // deposit_paid or captured — so a 'card_saved' job can be STAFFED but never
  // completed or charged until the scheduled authorization actually succeeds.
  allowSavedCard = false,
} = {}) {
  if (booking.financial_operation_key
      || booking.financial_operation_type
      || booking.financial_operation_started_at) {
    const op = String(booking.financial_operation_type || 'a payment operation').replace(/_/g, ' ');
    return {
      code: 'PAYMENT_OPERATION_IN_PROGRESS',
      message: `A ${op} is already running on this booking. Wait for it to finish, then try again.`,
    };
  }
  if (booking.financial_reconciliation_required_at) {
    return {
      code: 'FINANCIAL_RECONCILIATION_REQUIRED',
      message: "This booking's payment needs reconciling against Stripe before anyone can be assigned. Open the booking and clear the reconciliation hold.",
    };
  }
  if (booking.cancellation_reconciliation_required_at) {
    return {
      code: 'CANCELLATION_RECONCILIATION_REQUIRED',
      message: "This booking's cancellation needs reconciling against Stripe before anyone can be assigned. Open the booking and clear the reconciliation hold.",
    };
  }

  const disputeStatus = String(booking.stripe_dispute_status || '').toLowerCase();
  if (booking.stripe_dispute_id && !['won', 'warning_closed', 'prevented'].includes(disputeStatus)) {
    return {
      code: 'PAYMENT_DISPUTED',
      message: `The customer disputed this charge (dispute status: ${disputeStatus || 'open'}). Resolve the dispute in Stripe before assigning an Easer.`,
    };
  }

  const totalCents = Number(booking.total_price || 0);
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    const simulated = totalCents === 0
      && vercelEnv !== 'production'
      && booking.confirmed_by === 'owner_zero_dollar_simulation';
    if (simulated) return null;
    return {
      code: 'BOOKING_TOTAL_INVALID',
      message: totalCents === 0
        ? 'This booking has a $0 total, so there is no customer payment to verify. Price the booking before assigning an Easer.'
        : 'This booking has no valid total, so the customer payment cannot be verified. Price the booking before assigning an Easer.',
    };
  }

  const paymentStatus = String(booking.payment_status || '');

  if (paymentStatus === 'card_saved' && allowSavedCard) {
    if (!booking.stripe_payment_method_id) {
      return {
        code: 'SAVED_CARD_MISSING',
        message: "This booking is marked card saved but carries no saved payment method, so there is nothing to authorize before the visit. Reconcile it against Stripe before assigning.",
      };
    }
    return null;
  }

  if (!DISPATCH_PAYMENT_STATUSES.includes(paymentStatus)) {
    return {
      code: paymentStatus === 'card_saved' ? 'CARD_SAVED_AWAITING_AUTHORIZATION' : 'CUSTOMER_PAYMENT_NOT_AUTHORIZED',
      message: paymentStatus === 'card_saved'
        ? `The customer's card is saved but the hold is not taken until ${SCHEDULED_AUTHORIZATION_LEAD_DAYS} days before the appointment. The job can be staffed now; work starts after the hold.`
        : `The customer's card is "${paymentStatus || 'missing'}", not authorized. A card must be authorized (or a deposit paid) before an Easer can be assigned. This is the customer's payment, not the Easer's payout setup.`,
    };
  }

  if (paymentStatus === 'authorized') {
    if (!booking.stripe_payment_intent_id) {
      return {
        code: 'PAYMENT_INTENT_MISSING',
        message: "This booking is marked authorized but carries no Stripe PaymentIntent, so the customer's payment cannot be verified. Reconcile it against Stripe before assigning.",
      };
    }
    return null;
  }

  const depositCents = Number(booking.deposit_amount || 0);
  if (!Number.isInteger(depositCents) || depositCents <= 0 || depositCents > totalCents) {
    return {
      code: 'DEPOSIT_AMOUNT_INVALID',
      message: "This booking is marked deposit paid, but the deposit amount is missing or larger than the total, so the customer's payment cannot be verified.",
    };
  }
  if (!booking.stripe_deposit_intent_id && !booking.stripe_payment_intent_id) {
    return {
      code: 'DEPOSIT_INTENT_MISSING',
      message: "This booking is marked deposit paid but carries no Stripe intent, so the customer's payment cannot be verified. Reconcile it against Stripe before assigning.",
    };
  }
  return null;
}

export function isBookingPaymentReadyForDispatch(booking = {}, options = {}) {
  return describeDispatchPaymentBlock(booking, options) === null;
}

// Payment states a booking can be STAFFED in: offered to Easers, assigned,
// accepted. A confirmed saved card counts. Starting work and capture still
// require DISPATCH_PAYMENT_STATUSES.
export const STAFFING_PAYMENT_STATUSES = Object.freeze([...DISPATCH_PAYMENT_STATUSES, 'card_saved']);

export function describeStaffingPaymentBlock(booking = {}, options = {}) {
  return describeDispatchPaymentBlock(booking, { ...options, allowSavedCard: true });
}

export function isBookingPaymentReadyForStaffing(booking = {}, options = {}) {
  return describeStaffingPaymentBlock(booking, options) === null;
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

// A stored platform fee is a whole percent from 10 to 30. Catalog bookings use
// 30 (25 for a verified member when membership is on); a custom quote priced
// from an Easer's offer may use any whole percent in the range
// (api/booking/_quote-offers.js, pricing model v1 section 4). The database
// holds the same range (migration 131).
export const PLATFORM_FEE_PCT_RANGE = Object.freeze({ MIN: 10, MAX: 30 });

export function isAllowedPlatformFeePct(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= PLATFORM_FEE_PCT_RANGE.MIN && n <= PLATFORM_FEE_PCT_RANGE.MAX;
}

export function normalizePlatformFeePct(feePct, isMember = false) {
  const parsed = Number(feePct);
  return isAllowedPlatformFeePct(parsed) ? parsed : getPlatformFeePct(isMember);
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
 * platform-funded credit (for example AssembleCash or a review reward) reduced
 * what the customer paid but must NOT reduce the Easer's payout basis.
 *
 * A gift card is different: it is money the customer already paid (migration
 * 127). amountCharged/totalPrice is what the card paid; giftCardAppliedCents
 * is added back so tax, the Easer's pay and the platform's share are all
 * figured on the full price, exactly as on a job paid entirely by card.
 * totalCents stays the card amount.
 *
 * @param {{
 *   amountChargedCents?: number|null,
 *   totalPriceCents?: number|null,
 *   taxCents?: number,
 *   isMember?: boolean,
 *   feePct?: number|null,
 *   assemblecashRedeemedCents?: number,
 *   reviewRewardDiscountCents?: number,
 *   giftCardAppliedCents?: number,
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
  reviewRewardDiscountCents = 0,
  giftCardAppliedCents = 0,
} = {}) {
  const chargedRaw = amountChargedCents != null ? amountChargedCents : totalPriceCents;
  const total = Math.max(0, Math.round(Number(chargedRaw) || 0));
  const giftCard = Math.max(0, Math.round(Number(giftCardAppliedCents) || 0));
  const fullTotal = total + giftCard;
  const tax = Math.min(fullTotal, Math.max(0, Math.round(Number(taxCents) || 0)));
  const redeemed = Math.max(0, Math.round(Number(assemblecashRedeemedCents) || 0));
  const reviewRewardDiscount = Math.max(0, Math.round(Number(reviewRewardDiscountCents) || 0));
  const pretaxCollected = fullTotal - tax;
  const payoutBase = pretaxCollected + redeemed + reviewRewardDiscount;
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
    reviewRewardDiscountCents: reviewRewardDiscount,
    giftCardAppliedCents: giftCard,
  };
}

// Same-day fee is an ADDITIVE layer — it must never run through the 30/70 base
// split. These parts EXCLUDE it from the split base (its tax cancels out exactly
// in the subtraction, so the standard base stays penny-accurate); the fixed Easer
// rush bonus and platform remainder are added back on top. Moved here unchanged
// from api/booking/assembler-complete.js (2026-11-18) so the completion split and
// the ad conversion value read one rule.
export function sameDaySplitParts(booking) {
  const feeCents = Math.max(0, Number(booking?.same_day_fee_cents || 0));
  const bonusCents = Math.min(feeCents, Math.max(0, Number(booking?.same_day_easer_bonus_cents || 0)));
  const taxCents = Math.round(feeCents * SALES_TAX_RATE);
  return {
    grossCents: feeCents + taxCents,      // remove from amountCharged
    taxCents,                             // remove from taxCents
    bonusCents,                           // add to assemblerDue
    platformExtra: feeCents - bonusCents, // add to platformFee
  };
}

/**
 * What the platform keeps from a booking before card fees, excluding sales
 * tax: the platform fee from computeBookingSplitFromSnapshot plus the
 * platform's part of any same-day fee. This is the value reported to ad
 * platforms for a placed booking (owner, 2026-11-18: "send accurate platform
 * revenue excluding sales tax"); it is an estimate at booking time, not
 * captured revenue, and never a payout input.
 */
export function estimatedPlatformRevenueCents({
  totalCents = 0,
  taxCents = 0,
  sameDayFeeCents = 0,
  sameDayEaserBonusCents = 0,
  giftCardAppliedCents = 0,
  assemblecashRedeemedCents = 0,
  reviewRewardDiscountCents = 0,
  feePct = null,
  isMember = false,
} = {}) {
  const sameDay = sameDaySplitParts({ same_day_fee_cents: sameDayFeeCents, same_day_easer_bonus_cents: sameDayEaserBonusCents });
  const split = computeBookingSplitFromSnapshot({
    amountChargedCents: Math.max(0, Math.round(Number(totalCents) || 0) - sameDay.grossCents),
    taxCents: Math.max(0, Math.round(Number(taxCents) || 0) - sameDay.taxCents),
    isMember,
    feePct,
    assemblecashRedeemedCents,
    reviewRewardDiscountCents,
    giftCardAppliedCents,
  });
  return Math.max(0, split.platformFeeCents + sameDay.platformExtra);
}

// ─── Cancellation policy ─────────────────────────────────────────────────────
// Tiered cancellation fee as a % of the PRE-TAX SERVICE SUBTOTAL (labor only —
// NEVER tax, never the service-call fee). Free with reasonable notice; a fair,
// capped fee for late cancels; a higher fee once a pro is committed or for a
// no-show — but NEVER 100% (no work was performed). Server is the source of
// truth; never trust a client-sent fee.
// ── Easer cancellation reliability (owner, 2026-09-30) ─────────────────────
// Easers were cancelling accepted jobs at the last minute, including on the
// day of the job, with no consequence. Consequences come through access to
// work, not money (independent contractors; same model as TaskRabbit, where a
// Tasker cancellation inside 24h is a Terms violation counted over 90 days).
// This is the ONE place these numbers live.
export const EASER_RELIABILITY_POLICY = Object.freeze({
  graceMinutes: 15,          // cancel within 15 min of accepting: no strike (mis-tap)
  lateNoticeHours: 24,       // under 24h before the start: late cancellation
  lateStrikes: 1,
  sameDayStrikes: 2,         // on the calendar day of the job (Central time)
  noShowStrikes: 3,          // owner-confirmed no-show (an automatic flag alone never counts)
  windowDays: 90,            // strikes count for 90 days
  pauseAtStrikes: 3,         // at this many, the Easer is paused from new jobs
  dispatchPenaltyPerStrike: 150, // dispatch score points lost per active strike
  // Owner-confirmed problems on a job (owner, 2026-10-28 accountability table).
  // An automatic signal alone never counts; the owner checks, then confirms.
  lateArrivalStrikes: 1,     // 30+ minutes late, confirmed
  qualityStrikes: 1,         // workmanship problem, confirmed
  damageStrikes: 2,          // property damage, confirmed; also pauses new jobs at once
  // Online but not answering: offers for this many different jobs expire in a
  // row with no accept or decline, and the Easer is set offline (not a strike).
  unansweredOffersOffline: 3,
  unansweredWindowDays: 7,
  timeZone: 'America/Chicago',
});

function calendarDateIn(timeZone, ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Classify an Easer cancelling a job they ACCEPTED. Pure: no I/O.
//   kind: grace | advance | late | same_day
export function classifyEaserCancellation({ acceptedAtMs, nowMs, appointmentMs = null, appointmentDate = null }) {
  const P = EASER_RELIABILITY_POLICY;
  const minutesSinceAccept = Number.isFinite(acceptedAtMs) ? (nowMs - acceptedAtMs) / 60000 : Infinity;
  const hoursUntilStart = Number.isFinite(appointmentMs) ? (appointmentMs - nowMs) / 3600000 : null;
  const today = calendarDateIn(P.timeZone, nowMs);
  const isSameDay = (typeof appointmentDate === 'string' && appointmentDate.slice(0, 10) === today)
    || (hoursUntilStart != null && hoursUntilStart <= 0);
  let kind, strikes;
  if (minutesSinceAccept <= P.graceMinutes) { kind = 'grace'; strikes = 0; }
  else if (isSameDay) { kind = 'same_day'; strikes = P.sameDayStrikes; }
  else if (hoursUntilStart == null || hoursUntilStart < P.lateNoticeHours) { kind = 'late'; strikes = P.lateStrikes; }
  else { kind = 'advance'; strikes = 0; }
  return { kind, strikes, hoursUntilStart, minutesSinceAccept };
}

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
export function computeCancellationFee({ serviceSubtotalCents = 0, hoursUntilAppointment = null, status = null, isNoShow = false, forfeitFreeWindow = false, easerAccepted = false, easerNoShow = false } = {}) {
  const sub = Math.max(0, Math.round(Number(serviceSubtotalCents) || 0));
  const h = (typeof hoursUntilAppointment === 'number' && isFinite(hoursUntilAppointment)) ? hoursUntilAppointment : null;

  // ── An Easer did not show for this booking: the customer never pays ─────────
  // Owner-confirmed (api/owner/confirm-no-show.js, api/booking/_easer-no-show.js).
  // Only the owner's explicit customer no-show on a later visit (isNoShow)
  // can bring a fee back.
  if (easerNoShow === true && isNoShow !== true) {
    return { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false, waivedReason: 'easer_no_show', reason: 'easer_no_show' };
  }

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
    return { tier: 'free', feePct: 0, feeCents: 0, proTripCut: false, waivedReason: 'no_easer_accepted', reason: 'no_easer_accepted' };
  }

  const proCommitted = status === BOOKING_STATUS.EN_ROUTE || status === BOOKING_STATUS.ARRIVED || status === BOOKING_STATUS.IN_PROGRESS;

  // `reason` is the ONE statement of why this outcome applies. Every email,
  // page and dashboard that explains a cancellation fee renders this code;
  // none may work out its own reason (AAE-TYRHONCHIO: an email guessed
  // "24h+ notice" for a same-day cancellation whose real reason was
  // no_easer_accepted).
  let tier, feePct, reason;
  if (isNoShow || proCommitted || (h != null && h < CANCELLATION_POLICY.imminentWindowHours)) {
    tier = 'imminent'; feePct = CANCELLATION_POLICY.imminentFeePct;
    reason = isNoShow ? 'no_show' : (proCommitted ? 'pro_committed' : 'imminent_window');
  } else if (h != null && h < CANCELLATION_POLICY.freeWindowHours) {
    tier = 'late'; feePct = CANCELLATION_POLICY.lateFeePct; reason = 'late_window';
  } else {
    tier = 'free'; feePct = 0; reason = h == null ? 'notice_unknown' : 'free_window';
  }
  // A rescheduled booking forfeits its free window — at minimum the late tier applies.
  if (forfeitFreeWindow && tier === 'free') { tier = 'late'; feePct = CANCELLATION_POLICY.lateFeePct; reason = 'rescheduled'; }

  return { tier, feePct, feeCents: Math.round(sub * feePct / 100), proTripCut: tier === 'imminent', reason };
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
  // Owner-approved expense reimbursement (migration 112). Paid with the job but
  // not Easer earnings: it is a business expense, so it lowers the platform's
  // figures without ever being counted as what the Easer earned.
  easerReimbursementCents = 0,
  // Paid by gift card (migration 127): money collected when the card was sold,
  // so it counts beside the card charge. Refunds and processing fees apply to
  // the card charge only.
  giftCardAppliedCents = 0,
} = {}) {
  const grossChargedCents = Math.max(0, Math.round(Number(amountChargedCents || totalPriceCents) || 0));
  const refundedCents = Math.min(grossChargedCents, Math.max(0, Math.round(Number(refundAmountCents) || 0)));
  const netChargedCents = Math.max(0, grossChargedCents - refundedCents);
  const giftCardCents = grossChargedCents > 0 ? Math.max(0, Math.round(Number(giftCardAppliedCents) || 0)) : 0;
  const grossCollectedCents = grossChargedCents + giftCardCents;
  const netCollectedCents = netChargedCents + giftCardCents;
  const originalTaxCents = Math.min(grossCollectedCents, Math.max(0, Math.round(Number(taxAmountCents) || 0)));
  const taxCollectedCents = grossCollectedCents > 0
    ? Math.min(netCollectedCents, Math.round(originalTaxCents * netCollectedCents / grossCollectedCents))
    : 0;
  const recordedStripeFee = Number(stripeFeeCents);
  const processingFeeCents = stripeFeeCents != null && Number.isFinite(recordedStripeFee)
    ? Math.max(0, Math.round(recordedStripeFee))
    : estimateStripeFeeCents(netChargedCents);
  const payoutRecorded = Math.max(0, Math.round(Number(payoutAmountCents) || 0));
  const bonusCents = Math.max(0, Math.round(Number(easerBonusCents) || 0));
  const reimbursementCents = Math.max(0, Math.round(Number(easerReimbursementCents) || 0));
  // A recorded payout already includes the bonus and the reimbursement (both
  // rails pay easerPayoutDueCents), so the reimbursement is taken back out of
  // it and the bonus is only added to the un-paid estimate.
  const easerCostCents = payoutRecorded > 0
    ? Math.max(0, payoutRecorded - reimbursementCents)
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
    easerReimbursementCents: reimbursementCents,
    // What the platform actually kept before processing costs — DERIVED, never
    // the stored bookings.platform_fee column. That column is a snapshot of the
    // 30% commission at completion time, and a later goodwill discount does not
    // update it: the discount RPC deliberately preserves the Easer's earnings
    // and lets the platform absorb the reduction, so the stored fee keeps
    // claiming a commission the platform no longer took. Deriving it here means
    // the booking panel and the financial dashboard can never disagree about
    // the same job (Article 2).
    giftCardAppliedCents: giftCardCents,
    platformFeeCents: netCollectedCents - taxCollectedCents - easerCostCents - reimbursementCents,
    platformGrossCents: netCollectedCents - taxCollectedCents - processingFeeCents - easerCostCents - reimbursementCents,
  };
}

/**
 * What one booking pays its Easer, in cents. The ONE answer for both payout
 * rails (manual and Stripe Connect), the payout release check, the owner
 * ledger and the daily summary.
 *
 *   completed job:  assembler_due + easer_bonus_cents + easer_reimbursement_cents
 *   cancellation:   cancellation_easer_due_cents (no job ran: no bonus, no costs)
 *
 * The bonus and the reimbursement ride on top of computeBookingSplit, which
 * stays a pure function of what the customer paid. record_booking_payout
 * (migration 112) computes the same sum in SQL and refuses any other amount.
 */
export function easerPayoutDueCents(booking) {
  if (!booking) return 0;
  const cents = value => Math.max(0, Math.round(Number(value) || 0));
  if (booking.status === 'cancelled') return cents(booking.cancellation_easer_due_cents);
  return cents(booking.assembler_due) + cents(booking.easer_bonus_cents) + cents(booking.easer_reimbursement_cents);
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

// '787' is Austin. '782' is San Antonio proper and most of Bexar County, opened
// on 2026-09-23 once two ready Easers lived in that market.
//
// NOT '780' or '781', deliberately. Those prefixes reach far past the San
// Antonio commute shed: 78040-78046 is LAREDO, about 150 miles away. Adding
// '780' would have made a Laredo booking auto-offer to a San Antonio Easer,
// which is the exact harm the note below describes. The metro towns that do
// belong are listed by ZIP instead, the same way Austin's suburbs are.
//
// Houston (770-775) opened 2026-11-18 on the owner's authorization: Houston
// runs on automatic dispatch across its whole service market (Greater Houston:
// Katy, Spring, Cypress, The Woodlands, Sugar Land, Pearland, League City,
// Pasadena, Baytown, Galveston). The three conditions below hold: a ready Easer
// lives in the market, SERVICE_MARKETS.houston is this same list, and stranded
// or unaccepted jobs surface to the owner (expire-offers, unassigned
// escalation, stranded bookings). Offers still go only to Easers within their
// travel distance of the job (serviceAreaCheck) who pass every eligibility check.
export const HOUSTON_MARKET_ZIP_PREFIXES = Object.freeze(['770', '771', '772', '773', '774', '775']);
export const AUTOMATIC_DISPATCH_ZIP_PREFIXES = Object.freeze(['782', '787', ...HOUSTON_MARKET_ZIP_PREFIXES]);
export const AUTOMATIC_DISPATCH_ZIPS = Object.freeze([
  // Austin suburbs
  '78610', '78613', '78626', '78628', '78630', '78633', '78634',
  '78640', '78641', '78645', '78646', '78653', '78660', '78664',
  '78665', '78680', '78681', '78682', '78683', '78691',
  // San Antonio metro towns outside the 782 prefix
  '78006', '78015',           // Boerne
  '78108',                    // Cibolo
  '78130', '78132',           // New Braunfels
  '78148', '78154',           // Universal City, Schertz
]);
// Instant booking is open statewide: any valid Texas ZIP may book. This is safe
// only because auto-dispatch is deliberately NOT statewide — see
// isAutomaticDispatchZip below. A booking outside the auto-dispatch area is
// written with needs_manual_dispatch=true (api/booking.js), which BOTH the
// auto-dispatch cron and the dispatch engine refuse to act on, so a far-market
// job can never be blasted to an Austin Easer. It authorizes the card (a hold,
// not a charge) and waits for the owner to assign or cancel.
//
// Widening isAutomaticDispatchZip is now GATED, not forbidden. It used to be
// forbidden outright, because dispatch had no hard proximity rule and this
// narrowness was the only thing keeping a far-market job away from an Austin
// Pro. serviceAreaCheck (below) now enforces that directly: an offer goes only
// to Easers within their travel distance of the job, so adding a prefix here
// opens exactly one market and cannot leak into another.
//
// Before adding a prefix, confirm all three: a ready Easer actually lives in
// that market, SERVICE_MARKETS covers its prefixes, and someone is accountable
// for jobs that go unaccepted there. Opening a market with no local supply just
// moves a stranded booking from `manual_required` to an offer nobody answers.
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

// ── Service markets ────────────────────────────────────────────────────────
// A market is a set of 3-digit ZIP prefixes a single Easer can reasonably drive
// within. This is the ONE answer to "are these two ZIPs the same market"; do not
// re-derive it from city names, which drift (an "Austin" Easer on a Pflugerville
// job) and silently choke dispatch.
//
// WHY THIS EXISTS
// Dispatch scoring rewards a ZIP match (+75) but never *required* one. That was
// safe only while auto-dispatch was Austin-only AND every Easer was in Central
// Texas. Neither still holds: there are ready Easers in Lubbock, Houston and San
// Antonio. Without a hard gate, widening auto-dispatch by even one prefix would
// offer a Lubbock job to an Austin Easer.
//
// Austin deliberately spans 786 and 787 — Travis is 78660 (786) and real
// bookings have come from 78759 (787) and 78642 (786). A naive prefix-equality
// check would break the market that actually works.
//
// EVERY Texas ZIP is in exactly one market (owner, 2026-11-21: "everyone should
// be in a located area"). Until then Tyler (757) and Killeen (765) had no
// market, and the old fail-open rule offered those Easers every job in Texas:
// the Whitehouse Easer was offered a Houston job 166 miles away. A market is the
// AREA an Easer or a job is in, for the owner, reporting and the per-hub fee.
// It is NOT who gets an offer: that is distance, serviceAreaCheck() below,
// because one prefix can be 150 miles wide (780 runs from San Antonio to Laredo,
// 798 from El Paso to Big Bend). Opening automatic dispatch in a market is still
// gated separately (AUTOMATIC_DISPATCH_*, above).
export const SERVICE_MARKETS = Object.freeze({
  central_texas: Object.freeze(['733', '786', '787']),
  houston:       HOUSTON_MARKET_ZIP_PREFIXES,
  san_antonio:   Object.freeze(['780', '781', '782']),
  lubbock:       Object.freeze(['793', '794']),
  // 798 is the El Paso postal area (Far West Texas, Big Bend), not Midland.
  permian_basin: Object.freeze(['797']),
  // Owner, 2026-11-11: Dallas-Fort Worth is a priority hub with active Easers
  // (75227, 75409) and no market until now, so its Easers were offered jobs in
  // every other market and could not be counted as a hub.
  dallas_fort_worth: Object.freeze(['750', '751', '752', '753', '754', '760', '761', '762']),
  east_texas:        Object.freeze(['755', '756', '757', '758', '759']),
  wichita_falls:     Object.freeze(['763']),
  stephenville:      Object.freeze(['764']),
  waco_killeen:      Object.freeze(['765', '766', '767']),
  brownwood:         Object.freeze(['768']),
  san_angelo:        Object.freeze(['769']),
  beaumont:          Object.freeze(['776', '777']),
  brazos_valley:     Object.freeze(['778', '789']),
  victoria:          Object.freeze(['779']),
  corpus_christi:    Object.freeze(['783', '784']),
  rio_grande_valley: Object.freeze(['785']),
  southwest_texas:   Object.freeze(['788']),
  amarillo:          Object.freeze(['790', '791', '792']),
  abilene:           Object.freeze(['795', '796']),
  el_paso:           Object.freeze(['798', '799', '885']),
});

/** Which market does this ZIP belong to? Every Texas ZIP has one; null only for a non-Texas or malformed ZIP. */
export function marketForZip(zip) {
  const normalized = String(zip || '').trim();
  if (!/^\d{5}$/.test(normalized)) return null;
  const prefix = normalized.slice(0, 3);
  for (const [market, prefixes] of Object.entries(SERVICE_MARKETS)) {
    if (prefixes.includes(prefix)) return market;
  }
  return null;
}

/**
 * Are these two ZIPs in the same market? Reporting only: dispatch eligibility
 * is serviceAreaCheck(). Fails CLOSED: an unknown or non-Texas ZIP is in no
 * market, so it matches nothing (owner, 2026-11-21: the old fail-open answer
 * put two Easers with no market on every job in the state).
 */
export function isSameServiceMarket(bookingZip, easerZip) {
  const a = marketForZip(bookingZip);
  const b = marketForZip(easerZip);
  if (!a || !b) return false;
  return a === b;
}

// ── Service area: who may be offered a job ────────────────────────────────────
// The way field-service and home-service platforms do it (Salesforce Field
// Service "maximum travel from home", Thumbtack travel radius, Angi ZIP
// coverage): every Easer has a home ZIP and a travel distance, and a job is
// offered only to Easers whose home is within that distance of the job,
// nearest first. Distance is straight-line between ZIP points from the Census
// table in api/_texas-zip-locations.js. The 50-mile default is about an hour's
// drive and holds every metro we serve together: downtown Houston to Galveston
// is 47 miles, to Conroe 38; Pflugerville to San Marcos 45; Dallas to Denton
// 41. Whitehouse to Houston (166) and Harker Heights to Austin (55) are out.
// Easers choose 15, 25, 50 or 75 (profiles.travel_radius_miles, migration
// 132); unset means the default.
export const TRAVEL_RADIUS_MILES = Object.freeze({
  default: 50,
  options: Object.freeze([15, 25, 50, 75]),
  max: 75,
});

const METRES_PER_MILE = 1609.344;

/**
 * Where a ZIP is: { zip, lat, lng, precision } or null.
 * precision 'zip' is the ZIP's own Census point. A PO-box or business ZIP
 * (77001, 78711) has no Census area, so it takes the nearest-numbered ZIP in
 * the same 3-digit area, or failing that in the same market ('nearby_zip'):
 * the Postal Service numbers those near the town they serve. A non-Texas or
 * malformed ZIP returns null: nobody is offered that job automatically and the
 * owner assigns it.
 */
export function zipLocation(zip) {
  const normalized = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(normalized) || !isTexasZip(normalized)) return null;
  const exact = TEXAS_ZIP_LOCATIONS[normalized];
  if (exact) return { zip: normalized, lat: exact[0], lng: exact[1], precision: 'zip' };
  const prefix = normalized.slice(0, 3);
  const target = Number(normalized);
  const nearest = (prefixes) => {
    let best = null;
    for (const candidate of Object.keys(TEXAS_ZIP_LOCATIONS)) {
      if (!prefixes.includes(candidate.slice(0, 3))) continue;
      const gap = Math.abs(Number(candidate) - target);
      if (!best || gap < best.gap) best = { candidate, gap };
    }
    return best;
  };
  // Same 3-digit area first; an area that is all PO boxes (Houston 771, El
  // Paso 885) takes the nearest-numbered ZIP in its market instead.
  const market = marketForZip(normalized);
  const best = nearest([prefix]) || (market ? nearest(SERVICE_MARKETS[market]) : null);
  if (!best) return null;
  const [lat, lng] = TEXAS_ZIP_LOCATIONS[best.candidate];
  return { zip: normalized, lat, lng, precision: 'nearby_zip', basedOn: best.candidate };
}

/** Straight-line miles between two ZIPs, one decimal, or null when either cannot be located. */
export function milesBetweenZips(zipA, zipB) {
  const a = zipLocation(zipA);
  const b = zipLocation(zipB);
  if (!a || !b) return null;
  const metres = distanceMetres(a.lat, a.lng, b.lat, b.lng);
  return metres == null ? null : Math.round((metres / METRES_PER_MILE) * 10) / 10;
}

/** The Easer's travel distance in miles: their own choice, held to the platform maximum, or the default. */
export function easerTravelRadiusMiles(easer = {}) {
  const raw = easer?.travel_radius_miles;
  const miles = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(miles) || miles <= 0) return TRAVEL_RADIUS_MILES.default;
  return Math.min(Math.round(miles), TRAVEL_RADIUS_MILES.max);
}

/**
 * May this Easer be offered a job at `bookingZip`? THE rule, read by dispatch
 * (job offers and custom-quote price requests) and by the coverage check the
 * booking page and the owner alerts use.
 *   { ok: true,  reason: 'in_range', distanceMiles, radiusMiles }
 *   { ok: false, reason: 'too_far' | 'job_location_unknown' | 'easer_location_unknown', ... }
 * Fails CLOSED: a job or an Easer that cannot be placed on the map is offered
 * to nobody automatically. The job waits for the owner; it is never sent
 * statewide.
 */
export function serviceAreaCheck(bookingZip, easer = {}) {
  const radiusMiles = easerTravelRadiusMiles(easer);
  if (!zipLocation(bookingZip)) return { ok: false, reason: 'job_location_unknown', distanceMiles: null, radiusMiles };
  if (!zipLocation(easer?.zip)) return { ok: false, reason: 'easer_location_unknown', distanceMiles: null, radiusMiles };
  const distanceMiles = milesBetweenZips(bookingZip, easer.zip);
  if (distanceMiles == null) return { ok: false, reason: 'job_location_unknown', distanceMiles: null, radiusMiles };
  return distanceMiles <= radiusMiles
    ? { ok: true, reason: 'in_range', distanceMiles, radiusMiles }
    : { ok: false, reason: 'too_far', distanceMiles, radiusMiles };
}

// Service-call fee — FLAT $5 across all Texas booking zones.
// Server classification remains authoritative; the browser check is convenience only.
export const SERVICE_CALL_ZONES = Object.freeze({
  austin_core:    { label: 'Austin core', fee: 500 },
  near_suburb:    { label: 'Participating Central Texas communities', fee: 500 },
  houston_metro:  { label: 'Greater Houston', fee: 500 },
  texas_statewide: { label: 'Statewide Texas service', fee: 500 },
});

// Launch profit guardrails. These are pre-tax service-revenue floors, so sales
// tax can never make a weak job look profitable. Quote requests are exempt.
export const MIN_PRETAX_BOOKING_BY_ZONE = Object.freeze({
  austin_core: 12900,
  near_suburb: 14900,
  houston_metro: 14900,
  texas_statewide: 14900,
});

export function getMinimumPretaxBookingCents(zone) {
  return MIN_PRETAX_BOOKING_BY_ZONE[zone] || null;
}

export function getServiceCallZone(zip) {
  if (!isTexasZip(zip)) return null;
  const prefix = String(zip || '').trim().slice(0, 3);
  if (prefix === '787') return 'austin_core';
  if (HOUSTON_MARKET_ZIP_PREFIXES.includes(prefix)) return 'houston_metro';
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
