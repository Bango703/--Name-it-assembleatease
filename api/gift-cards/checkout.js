import Stripe from 'stripe';
import { rateLimit } from '../_ratelimit.js';
import { getSupabase } from '../_supabase.js';
import {
  GIFT_CARD_REDEMPTION_READY,
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
  getSb = getSupabase,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const enabled = isGiftCardsEnabled(env) && isGiftCardsConfigured(env);
    if (req.method === 'GET') {
      // /book shows the gift card field while cards are sold, and afterwards
      // for as long as any card is still active.
      let acceptingCodes = GIFT_CARD_REDEMPTION_READY && enabled;
      if (GIFT_CARD_REDEMPTION_READY && !acceptingCodes) {
        try {
          const { data } = await getSb().from('gift_cards').select('id').eq('status', 'active').limit(1);
          acceptingCodes = Array.isArray(data) && data.length > 0;
        } catch {
          acceptingCodes = false;
        }
      }
      return res.status(200).json({
        enabled,
        acceptingCodes,
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
