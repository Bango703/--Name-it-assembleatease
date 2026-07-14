export const BLOCKING_EASER_CLOSURE_STATUSES = Object.freeze([
  'requested',
  'reviewing',
  'completed',
]);

export function normalizeEaserClosureStatus(profileOrStatus) {
  const value = profileOrStatus && typeof profileOrStatus === 'object'
    ? profileOrStatus.account_closure_status
    : profileOrStatus;
  return String(value || '').trim().toLowerCase() || null;
}

/**
 * One source of truth for whether an account-closure state blocks new work
 * and authenticated Easer job mutations. A cancelled request deliberately
 * restores ordinary readiness checks; a completed closure is terminal.
 */
export function isEaserClosureBlocking(profileOrStatus) {
  return BLOCKING_EASER_CLOSURE_STATUSES.includes(
    normalizeEaserClosureStatus(profileOrStatus),
  );
}
