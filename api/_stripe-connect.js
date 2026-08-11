import Stripe from 'stripe';

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
    || message.includes('does not have access to account')
    || message.includes('account does not exist')
    || message.includes('application access may have been revoked')
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

// Retrieve the LIVE Connect account from Stripe and sync the cached capability
// flags on the Easer's profile (same field mapping as connect-status.js). This
// is the authoritative "is this Easer actually payouts-enabled right now?" read,
// used where the cached flag can lag reality (e.g. the reminder cron). It is
// self-healing: it writes the refreshed flags back so stale caches correct.
//
// Returns `payoutsEnabled`:
//   true  → live Stripe confirms payouts are enabled (Easer is done)
//   false → genuinely not enabled yet (no account, onboarding incomplete, or
//           the account was revoked and has been reset)
//   null  → could NOT verify (Stripe not configured / transient error); callers
//           should treat this as "unknown" and not act on it.
export async function refreshConnectPayoutState(sb, profile, options = {}) {
  const accountId = normalizeStripeConnectAccountId(profile?.stripe_connect_account_id);
  if (!accountId) {
    return { ok: false, reason: 'missing-connect-account', payoutsEnabled: false };
  }
  if (!process.env.STRIPE_SECRET_KEY && !options.stripeClient) {
    return { ok: false, reason: 'stripe-not-configured', payoutsEnabled: null };
  }
  try {
    const stripe = options.stripeClient || new Stripe(process.env.STRIPE_SECRET_KEY);
    const account = await stripe.accounts.retrieve(accountId);
    const updates = {
      stripe_connect_details_submitted: !!account.details_submitted,
      stripe_connect_charges_enabled: !!account.charges_enabled,
      stripe_connect_payouts_enabled: !!account.payouts_enabled,
      stripe_connect_onboarding_complete: !!(account.details_submitted && account.charges_enabled && account.payouts_enabled),
      stripe_connect_updated_at: new Date().toISOString(),
    };
    await sb.from('profiles').update(updates).eq('id', profile.id);
    return { ok: true, payoutsEnabled: updates.stripe_connect_payouts_enabled };
  } catch (err) {
    if (isRecoverableConnectAccountError(err)) {
      const reset = invalidConnectStateUpdate();
      await sb.from('profiles').update(reset).eq('id', profile.id);
      return { ok: true, reset: true, payoutsEnabled: false };
    }
    console.error('[refreshConnectPayoutState] retrieve failed:', err?.message || err);
    return { ok: false, reason: 'stripe-retrieve-failed', payoutsEnabled: null };
  }
}
