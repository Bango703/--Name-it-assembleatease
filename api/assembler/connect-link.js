import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';
import {
  invalidConnectStateUpdate,
  isRecoverableConnectAccountError,
  isStripeConnectEnabled,
  normalizeStripeConnectAccountId,
} from '../_stripe-connect.js';
import { deriveAssemblerStatus } from '../_assembler-state.js';
import { isEaserClosureBlocking, normalizeEaserClosureStatus } from '../_easer-closure.js';

const SITE = 'https://www.assembleatease.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isStripeConnectEnabled()) {
    return res.status(400).json({ error: 'Stripe Connect is not enabled' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Stripe is not configured' });
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
    .select('id, role, status, identity_verified, full_name, email, stripe_connect_account_id, account_closure_status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.role !== 'assembler') return res.status(403).json({ error: 'Only Easers can use this endpoint' });
  if (isEaserClosureBlocking(profile)) {
    return res.status(409).json({
      error: 'Resolve your account closure request before starting or changing payout setup.',
      code: 'ACCOUNT_CLOSURE_BLOCKS_PAYOUT_SETUP',
      closureStatus: normalizeEaserClosureStatus(profile),
    });
  }
  if (deriveAssemblerStatus(profile) !== 'active') {
    return res.status(403).json({ error: 'Your account must be approved before setting up payouts.' });
  }
  if (!profile.identity_verified) {
    return res.status(403).json({ error: 'Complete identity verification before setting up payouts. Reopen your AssembleAtEase verification link if needed.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let accountId = normalizeStripeConnectAccountId(profile.stripe_connect_account_id);

  if (profile.stripe_connect_account_id && !accountId) {
    await sb.from('profiles').update(invalidConnectStateUpdate()).eq('id', profile.id);
  }

  if (accountId) {
    try {
      await stripe.accounts.retrieve(accountId);
    } catch (err) {
      if (isRecoverableConnectAccountError(err)) {
        console.warn('connect-link resetting invalid Stripe Connect account:', err?.message || err);
        accountId = null;
        await sb.from('profiles').update(invalidConnectStateUpdate()).eq('id', profile.id);
      } else {
        console.error('connect-link retrieve error:', err?.message || err);
        return res.status(502).json({ error: 'Stripe payout setup is temporarily unavailable. Please try again shortly.' });
      }
    }
  }

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: profile.email || undefined,
      business_type: 'individual',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        mcc: '7299',
        product_description: 'Home assembly services',
      },
      metadata: {
        userId: profile.id,
        role: 'assembler',
      },
    });

    accountId = account.id;
    const { error: updateErr } = await sb.from('profiles').update({
      stripe_connect_account_id: account.id,
      stripe_connect_details_submitted: !!account.details_submitted,
      stripe_connect_charges_enabled: !!account.charges_enabled,
      stripe_connect_payouts_enabled: !!account.payouts_enabled,
      stripe_connect_onboarding_complete: !!(account.details_submitted && account.charges_enabled && account.payouts_enabled),
      stripe_connect_updated_at: new Date().toISOString(),
    }).eq('id', profile.id);
    if (updateErr) {
      console.error('connect-link profile update error:', updateErr);
      return res.status(500).json({ error: 'Failed to save Stripe Connect account' });
    }
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${SITE}/assembler/payouts?connect=refresh`,
    return_url: `${SITE}/assembler/payouts?connect=return`,
  });

  return res.status(200).json({
    ok: true,
    accountId,
    onboardingUrl: String(link.url || '').trim(),
    expiresAt: link.expires_at,
  });
}
