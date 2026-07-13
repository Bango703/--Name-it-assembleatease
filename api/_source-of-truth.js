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

// ── Sales tax ────────────────────────────────────────────────────────────────
// Texas sales tax rate (8.25%). Tax is a PASS-THROUGH LIABILITY owed to the state —
// it is NEVER platform revenue and must be excluded from the platform fee and the
// Easer payout base. Online bookings and customer-approved custom quotes store
// the exact server-calculated tax in bookings.tax_amount.
export const SALES_TAX_RATE = 0.0825;

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
  assemblecashRedeemedCents = 0,
} = {}) {
  const chargedRaw = amountChargedCents != null ? amountChargedCents : totalPriceCents;
  const total = Math.max(0, Math.round(Number(chargedRaw) || 0));
  const tax = Math.min(total, Math.max(0, Math.round(Number(taxCents) || 0)));
  const redeemed = Math.max(0, Math.round(Number(assemblecashRedeemedCents) || 0));
  const pretaxCollected = total - tax;
  const payoutBase = pretaxCollected + redeemed;
  const feePct = getPlatformFeePct(isMember);
  const protectedPlatformFee = Math.round(payoutBase * feePct / 100);
  const assemblerDue = payoutBase - protectedPlatformFee;
  const platformFee = pretaxCollected - assemblerDue;

  return {
    totalCents: total,
    taxCents: tax,
    pretaxCollectedCents: pretaxCollected,
    payoutBaseCents: payoutBase,
    feePct,
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
export function computeCancellationFee({ serviceSubtotalCents = 0, hoursUntilAppointment = null, status = null, isNoShow = false, forfeitFreeWindow = false } = {}) {
  const sub = Math.max(0, Math.round(Number(serviceSubtotalCents) || 0));
  const h = (typeof hoursUntilAppointment === 'number' && isFinite(hoursUntilAppointment)) ? hoursUntilAppointment : null;
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
  const easerCostCents = payoutRecorded > 0
    ? payoutRecorded
    : Math.max(0, Math.round(Number(assemblerDueCents) || 0));

  return {
    grossChargedCents,
    refundedCents,
    netChargedCents,
    taxCollectedCents,
    processingFeeCents,
    processingFeeIsActual: stripeFeeCents != null && Number.isFinite(recordedStripeFee),
    easerCostCents,
    platformGrossCents: netChargedCents - taxCollectedCents - processingFeeCents - easerCostCents,
  };
}

// Service-call fee — FLAT $25 across all served zones (covers Easer dispatch, travel, setup).
// Zone is still detected by 3-digit ZIP prefix for service-area validation. Server always recalculates.
export const SERVICE_CALL_ZONES = Object.freeze({
  austin_core:  { label: 'Austin core',    fee: 2500 },  // 787xx — Austin proper, Bee Cave, Lakeway
  near_suburb:  { label: 'Near suburbs',   fee: 2500 },  // 786xx — Round Rock, Cedar Park, Georgetown, Pflugerville, Kyle, Buda, Leander, Manor, Hutto
  far_suburb:   { label: 'Far suburbs',    fee: 2500 },  // 788xx — Bastrop, Lockhart
});

// Launch profit guardrails. These are pre-tax service-revenue floors, so sales
// tax can never make a weak job look profitable. Quote requests are exempt.
export const MIN_PRETAX_BOOKING_BY_ZONE = Object.freeze({
  austin_core: 12900,
  near_suburb: 14900,
  far_suburb: 16900,
});

export function getMinimumPretaxBookingCents(zone) {
  return MIN_PRETAX_BOOKING_BY_ZONE[zone] || null;
}

export function getServiceCallZone(zip) {
  const prefix = String(zip || '').slice(0, 3);
  if (prefix === '787') return 'austin_core';
  if (prefix === '786') return 'near_suburb';
  if (prefix === '788') return 'far_suburb';
  return null;
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
