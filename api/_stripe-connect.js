export function isStripeConnectEnabled() {
  return String(process.env.STRIPE_CONNECT_ENABLED || '').toLowerCase() === 'true';
}

export function normalizeStripeConnectAccountId(accountId) {
  const clean = String(accountId || '').trim();
  return /^acct_[A-Za-z0-9]+$/.test(clean) ? clean : null;
}

export function invalidConnectStateUpdate() {
  return {
    stripe_connect_account_id: null,
    stripe_connect_details_submitted: false,
    stripe_connect_charges_enabled: false,
    stripe_connect_payouts_enabled: false,
    stripe_connect_onboarding_complete: false,
    stripe_connect_updated_at: new Date().toISOString(),
  };
}

export function isRecoverableConnectAccountError(err) {
  const code = String(err?.code || '').toLowerCase();
  const type = String(err?.type || '').toLowerCase();
  const message = String(err?.message || '').toLowerCase();
  return (
    code === 'resource_missing'
    || code === 'parameter_invalid_string_empty'
    || type === 'invalid_request_error'
    || message.includes('no such account')
    || message.includes('expected pattern')
    || message.includes('string did not match')
  );
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
  const accountId = normalizeStripeConnectAccountId(profile?.stripe_connect_account_id);
  if (!accountId) {
    return { ok: false, reason: 'missing-connect-account' };
  }
  if (!profile.stripe_connect_onboarding_complete) {
    return { ok: false, reason: 'onboarding-incomplete', accountId };
  }
  if (!profile.stripe_connect_charges_enabled || !profile.stripe_connect_payouts_enabled) {
    return { ok: false, reason: 'capabilities-not-enabled', accountId };
  }

  return {
    ok: true,
    accountId,
  };
}
