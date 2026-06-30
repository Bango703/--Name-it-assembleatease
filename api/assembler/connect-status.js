import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import { isStripeConnectEnabled } from '../_stripe-connect.js';

function deriveUiState(profile, requirementsDue) {
  if (!profile?.stripe_connect_account_id) {
    return { code: 'action_required', label: 'Action Required', message: 'Set up Stripe payouts so AssembleAtEase can send your earnings to your bank. Job offers can still start once you are approved and online.' };
  }
  if (profile.stripe_connect_onboarding_complete && profile.stripe_connect_charges_enabled && profile.stripe_connect_payouts_enabled) {
    return { code: 'enabled', label: 'Enabled', message: 'Payouts are enabled.' };
  }
  if (requirementsDue > 0) {
    return { code: 'action_required', label: 'Action Required', message: 'Stripe needs additional information to enable payouts.' };
  }
  if (profile.stripe_connect_details_submitted) {
    return { code: 'restricted', label: 'Restricted', message: 'Stripe is reviewing your account capabilities.' };
  }
  return { code: 'pending', label: 'Pending', message: 'Complete Stripe onboarding to enable payouts.' };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!isStripeConnectEnabled()) {
    return res.status(200).json({
      enabled: false,
      connect: { code: 'disabled', label: 'Disabled', message: 'Stripe Connect is disabled.' },
    });
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);

  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await userClient.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const sb = getSupabase();
  const { data: profile, error: profileErr } = await sb
    .from('profiles')
    .select('id, role, status, stripe_connect_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled, stripe_connect_details_submitted, stripe_connect_updated_at')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.role !== 'assembler') return res.status(403).json({ error: 'Only Easers can use this endpoint' });

  let requirementsCurrentlyDue = [];

  if (process.env.STRIPE_SECRET_KEY && profile.stripe_connect_account_id) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);

      requirementsCurrentlyDue = Array.isArray(account?.requirements?.currently_due)
        ? account.requirements.currently_due
        : [];

      const updates = {
        stripe_connect_details_submitted: !!account.details_submitted,
        stripe_connect_charges_enabled: !!account.charges_enabled,
        stripe_connect_payouts_enabled: !!account.payouts_enabled,
        stripe_connect_onboarding_complete: !!(account.details_submitted && account.charges_enabled && account.payouts_enabled),
        stripe_connect_updated_at: new Date().toISOString(),
      };

      await sb.from('profiles').update(updates).eq('id', profile.id);
      Object.assign(profile, updates);
    } catch (err) {
      console.error('connect-status stripe sync error:', err?.message || err);
    }
  }

  const connect = deriveUiState(profile, requirementsCurrentlyDue.length);

  return res.status(200).json({
    enabled: true,
    connect,
    accountId: profile.stripe_connect_account_id || null,
    onboardingComplete: !!profile.stripe_connect_onboarding_complete,
    chargesEnabled: !!profile.stripe_connect_charges_enabled,
    payoutsEnabled: !!profile.stripe_connect_payouts_enabled,
    detailsSubmitted: !!profile.stripe_connect_details_submitted,
    requirementsCurrentlyDue,
    updatedAt: profile.stripe_connect_updated_at || null,
  });
}
