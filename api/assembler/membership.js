import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';

const SITE = 'https://www.assembleatease.com';
// Monthly membership price — set EASER_MEMBERSHIP_PRICE_ID in Vercel env
// Create a recurring product in Stripe dashboard and paste the price ID there.
// Default monthly amount shown to user: $39.99/month

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, userId, email } = req.body;
  if (!userId || !email) return res.status(400).json({ error: 'userId and email required' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sb = getSupabase();
  const priceId = process.env.EASER_MEMBERSHIP_PRICE_ID;

  // ── GET STATUS ────────────────────────────────────────────────────
  if (action === 'status') {
    const { data: profile } = await sb.from('profiles').select('has_membership, membership_expires_at, stripe_subscription_id').eq('id', userId).single();
    return res.status(200).json({
      active: profile?.has_membership || false,
      expiresAt: profile?.membership_expires_at || null,
      subscriptionId: profile?.stripe_subscription_id || null,
    });
  }

  // ── SUBSCRIBE — create Stripe checkout session ────────────────────
  if (action === 'subscribe') {
    if (!priceId) return res.status(500).json({ error: 'Membership not configured. Contact support.' });

    // Get or create Stripe customer
    const { data: profile } = await sb.from('profiles').select('stripe_customer_id').eq('id', userId).single();
    let customerId = profile?.stripe_customer_id;
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
