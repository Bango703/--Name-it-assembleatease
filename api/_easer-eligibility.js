const ALLOWED_OPERATIONAL_TIERS = new Set(['starter', 'professional', 'elite']);

export function normalizeEaserStatus(profile) {
  const tier = String(profile?.tier || '').toLowerCase();
  const applicationStatus = String(profile?.application_status || '').toLowerCase();
  let status = String(profile?.status || '').toLowerCase();

  // Backward-compatible derivation for legacy rows missing explicit status.
  if (!status) {
    if (applicationStatus === 'rejected' || tier === 'rejected') status = 'rejected';
    else if (tier === 'suspended') status = 'suspended';
    else if (tier === 'pending' || !tier) status = 'pending';
    else status = 'active';
  }

  return status;
}

export function getEaserOperationalEligibility(profile) {
  if (!profile) return { ok: false, error: 'Easer profile not found' };

  if (profile.role !== 'assembler') {
    return { ok: false, error: 'Forbidden' };
  }

  const status = normalizeEaserStatus(profile);
  const tier = String(profile.tier || '').toLowerCase();

  if (status !== 'active') {
    return {
      ok: false,
      error: 'Your Easer account is not eligible for operational actions right now.',
      code: 'EASER_STATUS_INELIGIBLE',
      status,
    };
  }

  if (profile.identity_verified !== true) {
    return {
      ok: false,
      error: 'Identity verification is required for operational actions.',
      code: 'EASER_IDENTITY_UNVERIFIED',
      status,
    };
  }

  if (!ALLOWED_OPERATIONAL_TIERS.has(tier)) {
    return {
      ok: false,
      error: 'Your Easer tier is not eligible for operational actions.',
      code: 'EASER_TIER_INELIGIBLE',
      status,
    };
  }

  return { ok: true, status };
}

export async function enforceEaserOperationalEligibility(sb, userId) {
  const { data: profile } = await sb
    .from('profiles')
    .select('id, role, tier, identity_verified, status, application_status')
    .eq('id', userId)
    .maybeSingle();

  const eligibility = getEaserOperationalEligibility(profile);
  return { ...eligibility, profile };
}
