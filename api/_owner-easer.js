// The ONE condition under which the owner's own Easer account may work an
// offline (owner_manual) booking whose customer payment is handled outside the
// platform and is therefore never Stripe-authorized. This is the single, deliberate exception
// to the dispatch payment gates, and it must stay exactly this narrow:
//
//   * the booking was created by the owner as an offline job (source='owner_manual'), AND
//   * its payment truth is the offline lane (payment_status='offline_recorded'), AND
//   * the acting / assigned Easer profile is the owner's own account (is_owner=true).
//
// A regular Easer can never satisfy is_owner, and a website booking can never be
// owner_manual, so no card-paid customer job is ever affected. The same rule is
// enforced independently at the database level by migration 042's assignment
// trigger — this module keeps the API gates in lockstep with that trigger.

export const OWNER_MANUAL_SOURCE = 'owner_manual';

export function isOwnerManualBooking(booking = {}) {
  return String(booking?.source || '') === OWNER_MANUAL_SOURCE;
}

export function isOwnerManualOfflineBooking(booking = {}) {
  return isOwnerManualBooking(booking)
    && String(booking?.payment_status || '') === 'offline_recorded';
}

export function isOwnerEaserProfile(profile = {}) {
  return profile?.is_owner === true && String(profile?.role || '') === 'assembler';
}

// True only when BOTH the booking is an offline owner-manual job AND the given
// Easer profile is the owner's own account. Every payment-gate exception must be
// guarded by this — never by source or is_owner alone.
export function isOwnerManualLiveFlow(booking, profile) {
  return isOwnerManualOfflineBooking(booking) && isOwnerEaserProfile(profile);
}
