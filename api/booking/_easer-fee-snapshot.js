import { computeBookingSplitFromSnapshot, getPlatformFeePct } from '../_source-of-truth.js';
import { hasEffectiveEaserMembership, isEaserMembershipEnabled } from '../_easer-membership.js';

export function validEaserFeePct(value) {
  const pct = Number(value);
  return pct === 25 || pct === 30 ? pct : null;
}

export function bookingHasCurrentEaserFeeSnapshot(booking, assemblerId = booking?.assembler_id) {
  const estimatedDue = Number(booking?.easer_estimated_due_snapshot);
  return !!assemblerId
    && booking?.easer_fee_snapshot_easer_id === assemblerId
    && validEaserFeePct(booking?.easer_fee_pct_snapshot) != null
    && booking?.easer_estimated_due_snapshot != null
    && Number.isInteger(estimatedDue)
    && estimatedDue >= 0
    && Number.isFinite(Date.parse(booking?.easer_fee_snapshot_at || ''));
}

export function buildEaserFeeSnapshot(booking, easer, {
  snapshottedAt = new Date().toISOString(),
} = {}) {
  if (!booking?.id || !easer?.id) {
    const error = new Error('A booking and verified Easer profile are required before earnings can be snapshotted.');
    error.code = 'EASER_FEE_SNAPSHOT_ASSIGNEE_MISSING';
    throw error;
  }
  if (isEaserMembershipEnabled() && typeof easer.has_membership !== 'boolean') {
    const error = new Error('Easer membership status could not be verified. Assignment was not changed.');
    error.code = 'EASER_FEE_SNAPSHOT_PROFILE_FAILED';
    throw error;
  }
  if (!Number.isFinite(Date.parse(snapshottedAt))) {
    const error = new Error('A valid fee snapshot timestamp is required.');
    error.code = 'EASER_FEE_SNAPSHOT_TIME_INVALID';
    throw error;
  }

  const feePct = getPlatformFeePct(hasEffectiveEaserMembership(easer));
  const estimate = computeBookingSplitFromSnapshot({
    totalPriceCents: booking.total_price,
    taxCents: booking.tax_amount || 0,
    feePct,
    assemblecashRedeemedCents: booking.assemblecash_redeemed_cents || 0,
  });
  const updates = {
    easer_fee_snapshot_easer_id: easer.id,
    easer_fee_pct_snapshot: feePct,
    easer_estimated_due_snapshot: estimate.assemblerDueCents,
    easer_fee_snapshot_at: snapshottedAt,
  };

  return {
    assemblerId: easer.id,
    feePct,
    estimatedDueCents: estimate.assemblerDueCents,
    snapshottedAt,
    updates,
    source: 'verified_profile_assignment_snapshot',
  };
}

export async function resolveOrCreateEaserFeeSnapshot(sb, booking, assemblerId = booking?.assembler_id) {
  if (!booking?.id || !assemblerId) {
    const error = new Error('A current assigned Easer is required before earnings can be calculated.');
    error.code = 'EASER_FEE_SNAPSHOT_ASSIGNEE_MISSING';
    throw error;
  }

  if (bookingHasCurrentEaserFeeSnapshot(booking, assemblerId)) {
    return {
      assemblerId,
      feePct: validEaserFeePct(booking.easer_fee_pct_snapshot),
      estimatedDueCents: Number(booking.easer_estimated_due_snapshot || 0),
      snapshottedAt: booking.easer_fee_snapshot_at || null,
      source: 'booking_snapshot',
    };
  }

  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, has_membership')
    .eq('id', assemblerId)
    .maybeSingle();
  if (profileError || !profile) {
    const error = new Error('Easer membership status could not be verified. No payment or payout calculation was performed.');
    error.code = 'EASER_FEE_SNAPSHOT_PROFILE_FAILED';
    error.cause = profileError || null;
    throw error;
  }

  const snapshot = buildEaserFeeSnapshot(booking, profile);
  const { updates } = snapshot;

  const { data: rows, error: snapshotError } = await sb
    .from('bookings')
    .update(updates)
    .eq('id', booking.id)
    .eq('assembler_id', assemblerId)
    .select('id');
  if (snapshotError || !rows?.length) {
    const error = new Error('The accepted Easer fee could not be snapshotted. No payment or payout calculation was performed.');
    error.code = 'EASER_FEE_SNAPSHOT_WRITE_FAILED';
    error.cause = snapshotError || null;
    throw error;
  }

  Object.assign(booking, updates);
  return {
    ...snapshot,
    source: 'profile_fail_closed_snapshot',
  };
}
