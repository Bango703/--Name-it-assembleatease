import Stripe from 'stripe';
import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { customerAccountUser } from '../booking/_customer-access.js';
import { findStripeCustomer, findOrCreateStripeCustomer } from '../_stripe-customer.js';

/**
 * Saved cards for a signed-in customer app account (owner, 2026-11-10: "a
 * customer can keep or store a card on the account for easy booking").
 *
 *   GET                       the account's saved cards
 *   POST { action: 'add' }    a SetupIntent to add a card from Account
 *   POST { action: 'checkout' } a customer session, so Stripe's payment sheet
 *                             offers the saved cards at checkout
 *   DELETE { paymentMethodId } remove a card, unless a booking still needs it
 *
 * Only a signed-in account whose email is confirmed (customerAccountUser).
 * The cards are the Stripe customer for that email (api/_stripe-customer.js),
 * the same one every booking saves its card to. Card details stay in Stripe;
 * this returns brand, last four digits and expiry only.
 */

// A booking still needs its card until it is cancelled, declined, refunded, or
// completed and paid: the card can be held before the visit, re-held, or
// charged for approved extra work or a balance.
const CLOSED_STATUSES = new Set(['cancelled', 'declined', 'refunded']);
export function bookingStillNeedsCard(booking) {
  const status = String(booking?.status || '');
  if (CLOSED_STATUSES.has(status)) return false;
  if (status === 'completed' && String(booking?.payment_status || '') === 'captured') return false;
  return true;
}

export function cardView(pm) {
  const card = pm?.card || {};
  return {
    id: pm.id,
    brand: String(card.brand || 'card'),
    last4: String(card.last4 || ''),
    exp_month: Number(card.exp_month) || 0,
    exp_year: Number(card.exp_year) || 0,
  };
}

// The sheet shows every saved card (including ones saved by a booking, which
// Stripe marks "limited" or leaves unspecified), and never removes or saves on
// its own: removal goes through DELETE below so the booking check runs, and a
// booking already saves the card it is paid with.
export const CHECKOUT_SESSION_COMPONENTS = Object.freeze({
  mobile_payment_element: {
    enabled: true,
    features: {
      payment_method_redisplay: 'enabled',
      payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
      payment_method_remove: 'disabled',
      payment_method_save: 'disabled',
    },
  },
});

function stripeClient() {
  return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

export default async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!(await (deps.rateLimit || rateLimit)(ip, 'booking'))) return res.status(429).json({ error: 'Too many tries. Wait a minute and try again.' });

  const sb = deps.sb || getSupabase();
  const user = await (deps.customerAccountUser || customerAccountUser)(sb, req);
  if (!user) return res.status(401).json({ error: 'Sign in again to see your cards.' });
  const email = String(user.email || '').trim().toLowerCase();

  const stripe = deps.stripe || stripeClient();
  if (!stripe) return res.status(503).json({ error: 'Saved cards are not available right now. Try again in a minute.' });

  try {
    if (req.method === 'GET') {
      const customer = await findStripeCustomer(stripe, email);
      if (!customer) return res.status(200).json({ cards: [] });
      const list = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 20 });
      return res.status(200).json({ cards: (list.data || []).map(cardView) });
    }

    if (req.method === 'POST') {
      const action = String(req.body?.action || '');
      if (action === 'add') {
        const customer = await findOrCreateStripeCustomer(stripe, email, { source: 'customer_account' });
        const intent = await stripe.setupIntents.create({
          customer: customer.id,
          payment_method_types: ['card'],
          usage: 'off_session',
          metadata: { email, source: 'customer_account' },
        });
        return res.status(200).json({ clientSecret: intent.client_secret });
      }
      if (action === 'checkout') {
        const customer = await findOrCreateStripeCustomer(stripe, email, { source: 'customer_account' });
        const session = await stripe.customerSessions.create({ customer: customer.id, components: CHECKOUT_SESSION_COMPONENTS });
        return res.status(200).json({ customerId: customer.id, customerSessionClientSecret: session.client_secret });
      }
      return res.status(400).json({ error: 'Unknown request.' });
    }

    // DELETE
    const paymentMethodId = String(req.body?.paymentMethodId || req.query?.paymentMethodId || '');
    if (!/^pm_[A-Za-z0-9]+$/.test(paymentMethodId)) return res.status(400).json({ error: 'Choose a card to remove.' });
    const customer = await findStripeCustomer(stripe, email);
    const pm = customer ? await stripe.paymentMethods.retrieve(paymentMethodId) : null;
    const owner = pm && (typeof pm.customer === 'string' ? pm.customer : pm.customer?.id);
    if (!customer || !pm || owner !== customer.id) return res.status(404).json({ error: 'That card is not on your account.' });

    if (await cardNeededByBooking(sb, stripe, customer.id, paymentMethodId)) {
      return res.status(409).json({ error: 'This card is set for a booking that is not paid yet. You can remove it once that job is paid.' });
    }
    await stripe.paymentMethods.detach(paymentMethodId);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[customer-payment-methods]', req.method, error?.type || '', error?.message || error);
    return res.status(503).json({ error: 'Your cards could not be updated right now. Try again in a minute.' });
  }
}

// True when an open booking saved this card or is paid with it.
export async function cardNeededByBooking(sb, stripe, customerId, paymentMethodId) {
  const { data: bySavedCard, error: savedError } = await sb.from('bookings')
    .select('id, status, payment_status')
    .eq('stripe_payment_method_id', paymentMethodId);
  if (savedError) throw new Error(savedError.message || 'bookings could not be read');
  if ((bySavedCard || []).some(bookingStillNeedsCard)) return true;

  const { data: byCustomer, error: customerError } = await sb.from('bookings')
    .select('id, status, payment_status, stripe_payment_intent_id')
    .eq('stripe_customer_id', customerId)
    .not('stripe_payment_intent_id', 'is', null);
  if (customerError) throw new Error(customerError.message || 'bookings could not be read');
  for (const booking of (byCustomer || []).filter(bookingStillNeedsCard)) {
    const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id);
    const method = typeof intent?.payment_method === 'string' ? intent.payment_method : intent?.payment_method?.id;
    if (method === paymentMethodId) return true;
  }
  return false;
}
