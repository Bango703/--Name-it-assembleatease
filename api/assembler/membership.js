import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { getSupabase } from '../_supabase.js';

const SITE = 'https://www.assembleatease.com';
// Monthly membership price — set AAE_EASER_MEMBERSHIP in Vercel env
// Create a recurring product in Stripe dashboard and paste the price ID there.
// Default monthly amount shown to user: $24.99/month

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify JWT — userId must come from the verified token, not the request body
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await userClient.auth.getUser(auth.replace('Bearer ', ''));
  if (authErr || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { action } = req.body;
  // Always derive userId and email from the verified JWT — never trust the body
  const userId = user.id;
  const email  = user.email;

  if (!userId || !email) return res.status(400).json({ error: 'userId and email required' });

  const sb = getSupabase();

  // ── GET STATUS — Supabase only, no Stripe needed ──────────────────
  if (action === 'status') {
    const { data: profile } = await sb.from('profiles').select('has_membership, membership_expires_at, stripe_subscription_id').eq('id', userId).single();
    return res.status(200).json({
      active: profile?.has_membership || false,
      expiresAt: profile?.membership_expires_at || null,
      subscriptionId: profile?.stripe_subscription_id || null,
    });
  }

  // For all other actions Stripe is required — instantiate here so a
  // missing STRIPE_SECRET_KEY never crashes the status check above.
  if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: 'Membership not yet configured.' });
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const priceId = process.env.AAE_EASER_MEMBERSHIP;

  // ── SUBSCRIBE — create Stripe checkout session ────────────────────
  if (action === 'subscribe') {
    if (!priceId) return res.status(503).json({ error: 'Membership not configured. Contact support.' });

    try {
      // Get or create Stripe customer — verify stored ID is still valid
      const { data: profile } = await sb.from('profiles').select('stripe_customer_id').eq('id', userId).single();
      let customerId = profile?.stripe_customer_id;
      if (customerId) {
        try {
          await stripe.customers.retrieve(customerId);
        } catch (custErr) {
          // Stored customer doesn't exist in this Stripe environment — clear it
          if (custErr.code === 'resource_missing') {
            customerId = null;
            await sb.from('profiles').update({ stripe_customer_id: null }).eq('id', userId);
          } else { throw custErr; }
        }
      }
      if (!customerId) {
        const customer = await stripe.customers.create({ email, metadata: { userId, role: 'assembler' } });
        customerId = customer.id;
        await sb.from('profiles').update({ stripe_customer_id: customerId }).eq('id', userId);
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: SITE + '/assembler/?membership=success',
        cancel_url:  SITE + '/assembler/?membership=cancelled',
        metadata: { userId, role: 'assembler_membership' },
        subscription_data: { metadata: { userId } },
        allow_promotion_codes: true,
      });

      return res.status(200).json({ url: session.url });
    } catch (stripeErr) {
      console.error('[membership] Stripe subscribe error:', stripeErr.message);
      return res.status(502).json({ error: stripeErr.message || 'Payment provider error. Please try again.' });
    }
  }

  // ── CANCEL ────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const { data: profile } = await sb.from('profiles').select('stripe_subscription_id').eq('id', userId).single();
    if (!profile?.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });

    await stripe.subscriptions.update(profile.stripe_subscription_id, { cancel_at_period_end: true });
    return res.status(200).json({ ok: true, message: 'Membership will cancel at end of billing period' });
  }

  // ── PORTAL — manage billing ────────────────────────────────────────
  if (action === 'portal') {
    const { data: profile } = await sb.from('profiles').select('stripe_customer_id').eq('id', userId).single();
    if (!profile?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: SITE + '/assembler/',
    });
    return res.status(200).json({ url: session.url });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
