import Stripe from 'stripe';
import { rateLimit } from '../_ratelimit.js';
import {
  isGiftCardsEnabled, isGiftCardsConfigured, validatePurchase, checkoutSessionParams,
  GIFT_CARD_MIN_CENTS, GIFT_CARD_MAX_CENTS, GIFT_CARD_PRESET_CENTS, MOVE_IN_PASS,
} from '../_gift-cards.js';

/**
 * GET  /api/gift-cards/checkout  what can be bought right now
 * POST /api/gift-cards/checkout  start a Stripe Checkout for one card
 *
 * Nothing is sold while GIFT_CARDS_ENABLED is off. The amount charged is
 * decided by api/_gift-cards.js, never by the browser.
 */
export function createGiftCardCheckoutHandler({
  env = process.env,
  limit = rateLimit,
  stripeFactory = (key) => new Stripe(key),
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const enabled = isGiftCardsEnabled(env) && isGiftCardsConfigured(env);
    if (req.method === 'GET') {
      return res.status(200).json({
        enabled,
        minCents: GIFT_CARD_MIN_CENTS,
        maxCents: GIFT_CARD_MAX_CENTS,
        presetCents: GIFT_CARD_PRESET_CENTS,
        moveInPass: MOVE_IN_PASS,
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!enabled) return res.status(409).json({ error: 'Gift cards are not on sale yet.' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!(await limit(`checkout:${ip}`, 'gift_card'))) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }

    const checked = validatePurchase(req.body || {});
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    try {
      const stripe = stripeFactory(env.STRIPE_SECRET_KEY);
      const session = await stripe.checkout.sessions.create(checkoutSessionParams(checked.purchase));
      return res.status(200).json({ url: session.url });
    } catch (error) {
      console.error('[gift-cards] checkout failed:', error?.message || error);
      return res.status(502).json({ error: 'Checkout could not be opened. Try again in a moment.' });
    }
  };
}

export default createGiftCardCheckoutHandler();
