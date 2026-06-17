export const ACTIVE_EASER_TIERS = Object.freeze(['starter', 'professional', 'elite']);

export function normalizeAssemblerTier(rawTier) {
  const tier = String(rawTier || '').trim().toLowerCase();
  if (!tier) return null;
  return tier === 'verified' ? 'professional' : tier;
}

export function deriveAssemblerStatus(profile = {}) {
  const tier = normalizeAssemblerTier(profile.tier);
  const status = String(profile.status || '').trim().toLowerCase();
  const applicationStatus = String(profile.application_status || '').trim().toLowerCase();

  if (status === 'rejected' || applicationStatus === 'rejected' || tier === 'rejected') return 'rejected';
  if (status === 'suspended' || tier === 'suspended') return 'suspended';
  if (status === 'pending' || applicationStatus === 'pending') return 'pending';
  if (status === 'active') return 'active';
  if (ACTIVE_EASER_TIERS.includes(tier)) return 'active';
  if (tier === 'pending' || !tier) return 'pending';
  return status || 'pending';
}

export function normalizeAssemblerProfile(profile = {}) {
  const tier = normalizeAssemblerTier(profile.tier);
  return {
    ...profile,
    tier,
    status: deriveAssemblerStatus({ ...profile, tier }),
  };
}

export function getPreservedTier(profile = {}) {
  const tier = normalizeAssemblerTier(profile.tier);
  if (ACTIVE_EASER_TIERS.includes(tier)) return tier;
  const previousTier = normalizeAssemblerTier(profile.previous_tier);
  return ACTIVE_EASER_TIERS.includes(previousTier) ? previousTier : null;
}

export function getRestorableTier(profile = {}) {
  return getPreservedTier(profile) || 'starter';
}
