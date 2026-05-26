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
  MEMBER: 18,
  NON_MEMBER: 25,
});

export function getPlatformFeePct(isMember) {
  return isMember ? MEMBERSHIP_PLATFORM_FEE_PCT.MEMBER : MEMBERSHIP_PLATFORM_FEE_PCT.NON_MEMBER;
}

export function isActiveBookingStatus(status) {
  return ACTIVE_BOOKING_STATUSES.includes(status);
}

export function isTerminalBookingStatus(status) {
  return TERMINAL_BOOKING_STATUSES.includes(status);
}
