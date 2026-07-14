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
    .select('id, role, status, stripe_connect_account_id, account_closure_status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || !profile) return res.status(404).json({ error: 'Profile not found' });
  if (profile.role !== 'assembler') return res.status(403).json({ error: 'Only Easers can use this endpoint' });
  if (isEaserClosureBlocking(profile)) {
    return res.status(409).json({
      error: 'Resolve your account closure request before opening payout management.',
      code: 'ACCOUNT_CLOSURE_BLOCKS_PAYOUT_SETUP',
      closureStatus: normalizeEaserClosureStatus(profile),
    });
  }
  if (deriveAssemblerStatus(profile) !== 'active') return res.status(403).json({ error: 'Your account must be active to manage payouts.' });
  const accountId = normalizeStripeConnectAccountId(profile.stripe_connect_account_id);
  if (!accountId) {
    if (profile.stripe_connect_account_id) {
      await sb.from('profiles').update(invalidConnectStateUpdate()).eq('id', profile.id);
    }
    return res.status(400).json({ error: 'Stripe payout account is not set up yet.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const login = await stripe.accounts.createLoginLink(accountId);
    return res.status(200).json({ ok: true, url: login.url });
  } catch (err) {
    if (isRecoverableConnectAccountError(err)) {
      await sb.from('profiles').update(invalidConnectStateUpdate()).eq('id', profile.id);
      return res.status(409).json({ error: 'Your payout setup needs to be restarted. Open the payout setup button again to continue.' });
    }
    console.error('connect-login error:', err?.message || err);
    return res.status(500).json({ error: 'Unable to open Stripe dashboard right now.' });
  }
}
