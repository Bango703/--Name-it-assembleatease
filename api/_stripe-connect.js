export function isStripeConnectEnabled() {
  return String(process.env.STRIPE_CONNECT_ENABLED || '').toLowerCase() === 'true';
}

export async function getAssemblerConnectAccount(sb, assemblerId) {
  if (!assemblerId) return { ok: false, reason: 'missing-assembler-id' };

  const { data: profile, error } = await sb
    .from('profiles')
    .select('stripe_connect_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled')
    .eq('id', assemblerId)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: 'profile-query-failed', error };
  }
  if (!profile?.stripe_connect_account_id) {
    return { ok: false, reason: 'missing-connect-account' };
  }
  if (!profile.stripe_connect_onboarding_complete) {
    return { ok: false, reason: 'onboarding-incomplete', accountId: profile.stripe_connect_account_id };
  }
  if (!profile.stripe_connect_charges_enabled || !profile.stripe_connect_payouts_enabled) {
    return { ok: false, reason: 'capabilities-not-enabled', accountId: profile.stripe_connect_account_id };
  }

  return {
    ok: true,
    accountId: profile.stripe_connect_account_id,
  };
}
