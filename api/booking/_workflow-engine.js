import { BOOKING_STATUS, TERMINAL_BOOKING_STATUSES } from '../_source-of-truth.js';

function norm(status) {
  return String(status || '').trim().toLowerCase();
}

// Phase 1 foundation: single workflow map for legal booking status transitions.
export const BOOKING_WORKFLOW_TRANSITIONS = Object.freeze({
  [BOOKING_STATUS.PENDING]: Object.freeze([
    BOOKING_STATUS.CONFIRMED,
    BOOKING_STATUS.DECLINED,
    BOOKING_STATUS.CANCELLED,
  ]),
  [BOOKING_STATUS.CONFIRMED]: Object.freeze([
    BOOKING_STATUS.EN_ROUTE,
    BOOKING_STATUS.CANCELLED,
  ]),
  [BOOKING_STATUS.EN_ROUTE]: Object.freeze([
    BOOKING_STATUS.ARRIVED,
    BOOKING_STATUS.CANCELLED,
  ]),
  [BOOKING_STATUS.ARRIVED]: Object.freeze([
    BOOKING_STATUS.IN_PROGRESS,
    BOOKING_STATUS.CANCELLED,
  ]),
  [BOOKING_STATUS.IN_PROGRESS]: Object.freeze([
    BOOKING_STATUS.COMPLETED,
    BOOKING_STATUS.CANCELLED,
  ]),
  [BOOKING_STATUS.COMPLETED]: Object.freeze([]),
  [BOOKING_STATUS.CANCELLED]: Object.freeze([]),
  [BOOKING_STATUS.DECLINED]: Object.freeze([]),
  [BOOKING_STATUS.REFUNDED]: Object.freeze([]),
});

export function getAllowedNextStatuses(currentStatus) {
  return BOOKING_WORKFLOW_TRANSITIONS[norm(currentStatus)] || [];
}

export function canTransitionBookingStatus(currentStatus, nextStatus, opts = {}) {
  const from = norm(currentStatus);
  const to = norm(nextStatus);
  const allowNoop = opts.allowNoop === true;

  if (!from || !to) return false;
  if (from === to) return allowNoop;

  return getAllowedNextStatuses(from).includes(to);
}

export function getTransitionError(currentStatus, nextStatus, opts = {}) {
  const from = norm(currentStatus);
  const to = norm(nextStatus);
  const allowNoop = opts.allowNoop === true;

  if (!from) return 'Current booking status is missing';
  if (!to) return 'Target booking status is missing';
  if (from === to && allowNoop) return null;
  if (canTransitionBookingStatus(from, to, { allowNoop })) return null;

  if (TERMINAL_BOOKING_STATUSES.includes(from)) {
    return 'Cannot transition terminal booking status: ' + from;
  }

  const allowed = getAllowedNextStatuses(from);
  if (!allowed.length) {
    return 'No transitions allowed from booking status: ' + from;
  }

  return 'Invalid booking status transition: ' + from + ' -> ' + to + '. Allowed: ' + allowed.join(', ');
}
