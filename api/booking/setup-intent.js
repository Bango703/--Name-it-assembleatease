import Stripe from 'stripe';
import { rateLimit, rateLimitKey } from '../_ratelimit.js';

/**
 * POST /api/booking/setup-intent
 * Creates a Stripe Customer + SetupIntent for saving a card off-session.
 * Used by the quote booking flow — collects card upfront, no charge until
 * the owner finalizes the quote price via /api/owner/quote-approve.
 * Body: { name, email }
 * Returns: { clientSecret, customerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!await rateLimit(ip, 'setup_intent')) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { name, email } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (String(name || '').length > 120) {
    return res.status(400).json({ error: 'Name is too long' });
  }

  // Add a tighter per-ip+email bucket to slow down card-setup abuse.
  const emailScopeAllowed = await rateLimitKey(`${ip}:${normalizedEmail}`, 'setup_intent_email');
  if (!emailScopeAllowed) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'Payment service unavailable' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Reuse existing Stripe customer if one exists for this email
    const existing = await stripe.customers.list({ email: normalizedEmail, limit: 1 });
    const customer = existing.data[0] || await stripe.customers.create({
      email: normalizedEmail,
      name: name || normalizedEmail,
      metadata: { source: 'quote_booking' },
    });

    // SetupIntent with off_session usage so the card can be charged later
    // without the customer present (when owner finalizes the quote)
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { email: normalizedEmail, source: 'quote_booking' },
    });

    return res.status(200).json({
      clientSecret: setupIntent.client_secret,
      customerId: customer.id,
    });
  } catch (err) {
    console.error('setup-intent error:', err);
    return res.status(500).json({ error: 'Failed to set up payment form. Please try again.' });
  }
}
