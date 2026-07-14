/**
 * Easer membership is a separate, future contractor product. It is not the
 * customer Setup Club membership and must never become active just because a
 * price ID or a stale profile flag exists.
 */
export function isEaserMembershipEnabled() {
  return String(process.env.EASER_MEMBERSHIP_ENABLED || '').trim().toLowerCase() === 'true';
}

export function hasEffectiveEaserMembership(profile) {
  return isEaserMembershipEnabled() && profile?.has_membership === true;
}
