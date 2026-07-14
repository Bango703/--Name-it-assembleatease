import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import {
  authenticateBearerUser,
  isActiveApprovedEaserProfile,
  respondWithEaserAccessError,
} from '../_easer-access.js';
import {
  hasEffectiveEaserMembership,
  isEaserMembershipEnabled,
} from '../_easer-membership.js';

const SITE = 'https://www.assembleatease.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authenticated = await authenticateBearerUser(req);
  if (!authenticated.ok) return respondWithEaserAccessError(res, authenticated);

  const action = String(req.body?.action || '').trim().toLowerCase();
  const sb = getSupabase();
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, role, status, application_status, tier, identity_verified, contractor_agreement_signed_at, code_of_conduct_agreed_at, has_membership, membership_expires_at, stripe_customer_id, stripe_subscription_id')
    .eq('id', authenticated.user.id)
    .maybeSingle();

  if (profileError) {
    console.error('[easer-membership] Profile lookup failed:', profileError.message || profileError);
    return res.status(503).json({ error: 'Membership status could not be verified. Please try again.' });
  }
  if (!profile || profile.role !== 'assembler') {
    return res.status(403).json({ error: 'An Easer account is required.' });
  }

  const enabled = isEaserMembershipEnabled();
  const legacySubscriptionActive = profile.has_membership === true && Boolean(profile.stripe_subscription_id);

  if (action === 'status') {
    return res.status(200).json({
      enabled,
      active: legacySubscriptionActive,
      benefitsActive: hasEffectiveEaserMembership(profile),
      canSubscribe: enabled && isActiveApprovedEaserProfile(profile),
      expiresAt: legacySubscriptionActive ? profile.membership_expires_at || null : null,
    });
  }

  // A disabled future product must not become purchasable merely because a
  // Stripe price ID happens to be present in the environment.
  if (action === 'subscribe' && !enabled) {
    return res.status(409).json({ error: 'Easer membership is not available at launch.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Membership billing is not configured.' });
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  if (action === 'subscribe') {
    if (!isActiveApprovedEaserProfile(profile)) {
      return res.status(403).json({ error: 'An active, approved Easer account is required.' });
    }
    if (legacySubscriptionActive) {
      return res.status(409).json({ error: 'An active subscription already exists.' });
    }
    const priceId = process.env.AAE_EASER_MEMBERSHIP;
    if (!priceId) return res.status(503).json({ error: 'Membership billing is not configured.' });

    try {
      let customerId = profile.stripe_customer_id || null;
      if (customerId) {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          if (customer?.deleted) customerId = null;
        } catch (customerError) {
          if (customerError?.code === 'resource_missing') customerId = null;
          else throw customerError;
        }
      }

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: authenticated.user.email,
          metadata: { userId: authenticated.user.id, role: 'assembler' },
        });
        customerId = customer.id;
        const { error: customerWriteError } = await sb
          .from('profiles')
          .update({ stripe_customer_id: customerId })
          .eq('id', authenticated.user.id)
          .eq('role', 'assembler');
        if (customerWriteError) throw customerWriteError;
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${SITE}/assembler/?membership=success`,
        cancel_url: `${SITE}/assembler/?membership=cancelled`,
        metadata: { userId: authenticated.user.id, role: 'assembler_membership' },
        subscription_data: {
          metadata: { userId: authenticated.user.id, role: 'assembler_membership' },
        },
        allow_promotion_codes: true,
      });
      return res.status(200).json({ url: session.url });
    } catch (error) {
      console.error('[easer-membership] Checkout failed:', error?.message || error);
      return res.status(502).json({ error: 'Membership checkout could not be started. Please try again.' });
    }
  }

  // Cancellation and portal access remain available while the feature is off
  // so an accidental or legacy subscriber is never trapped in recurring billing.
  if (action === 'cancel') {
    if (!profile.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found.' });
    }
    try {
      await stripe.subscriptions.update(profile.stripe_subscription_id, { cancel_at_period_end: true });
      return res.status(200).json({ ok: true, message: 'Membership will cancel at the end of the billing period.' });
    } catch (error) {
      console.error('[easer-membership] Cancellation failed:', error?.message || error);
      return res.status(502).json({ error: 'Membership cancellation could not be scheduled. Contact support.' });
    }
  }

  if (action === 'portal') {
    if (!profile.stripe_customer_id || !profile.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active billing account found.' });
    }
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: profile.stripe_customer_id,
        return_url: `${SITE}/assembler/profile`,
      });
      return res.status(200).json({ url: session.url });
    } catch (error) {
      console.error('[easer-membership] Portal failed:', error?.message || error);
      return res.status(502).json({ error: 'Billing management could not be opened. Contact support.' });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
}
