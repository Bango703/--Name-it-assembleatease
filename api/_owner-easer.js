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

import { isDemoEaser } from './_demo-accounts.js';

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

// The second, equally narrow exception: a DEMO Easer account (App Store review,
// profiles.is_demo_account) working an offline booking the owner marked as a
// TEST booking. It lets a reviewer run the whole job flow without any customer,
// card or Stripe money existing:
//
//   * the booking is an offline owner-manual job (source + payment lane above), AND
//   * the booking is marked is_test_booking = true, AND
//   * the Easer is a demo account (read with its own query, api/_demo-accounts.js).
//
// A real booking can never be a test booking with a demo Easer on it: dispatch,
// assign, crew and accept all refuse that (demoBookingBlock), and migration 107
// refuses it in the database. Completion records no payout for it.
export async function isDemoTestLiveFlow(sb, booking, easerId) {
  if (!isOwnerManualOfflineBooking(booking) || booking?.is_test_booking !== true) return false;
  return isDemoEaser(sb, easerId);
}

/** Owner-Easer or demo-test live flow: the only cases that skip the card gates. */
export async function isOfflineLiveFlow(sb, booking, profile) {
  if (isOwnerManualLiveFlow(booking, profile)) return true;
  return isDemoTestLiveFlow(sb, booking, profile?.id);
}
