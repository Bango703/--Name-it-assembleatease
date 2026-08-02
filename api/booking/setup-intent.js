import Stripe from 'stripe';
import { rateLimit, rateLimitKey } from '../_ratelimit.js';
import { guardCustomerFacing } from '../_customer-error-alert.js';
import { needsScheduledAuthorization, validateBookingWindowDate } from './_booking-window.js';

/**
 * POST /api/booking/setup-intent
 * Creates a Stripe Customer + SetupIntent for saving a card off-session.
 * Used by quote requests and appointments outside the immediate authorization
 * window. It saves a card without charging it. Quotes still require the
 * customer's one-time approval link before /api/owner/quote-approve may
 * authorize a final amount. Future priced bookings are authorized by the
 * scheduled worker only when they enter the five-day window.
 * Body: { name, email, purpose?, date? }
 * Returns: { clientSecret, customerId }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  guardCustomerFacing(req, res, 'booking card setup');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!await rateLimit(ip, 'setup_intent')) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });

  const { name, email, purpose, date } = req.body || {};
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (String(name || '').length > 120) {
    return res.status(400).json({ error: 'Name is too long' });
  }

  const normalizedPurpose = purpose === 'future_booking' ? 'future_booking' : 'quote_booking';
  if (normalizedPurpose === 'future_booking') {
    const dateCheck = validateBookingWindowDate(date);
    if (!dateCheck.ok || !needsScheduledAuthorization(date)) {
      return res.status(409).json({
        error: 'This appointment does not qualify for scheduled payment authorization.',
        code: 'FUTURE_BOOKING_SETUP_NOT_ALLOWED',
      });
    }
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
      metadata: { source: normalizedPurpose },
    });

    // SetupIntent with off_session usage so the card can be charged later
    // without the customer present (when owner finalizes the quote)
    const setupIntent = await stripe.setupIntents.create({
      customer: customer.id,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: {
        email: normalizedEmail,
        source: normalizedPurpose,
        ...(normalizedPurpose === 'future_booking' ? { appointmentDate: String(date) } : {}),
      },
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
