import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { lookupBalance } from '../_gift-cards.js';

/**
 * POST /api/gift-cards/balance  { code }
 * What is left on a card. Shows no names or email addresses.
 */
export function createGiftCardBalanceHandler({ getSb = getSupabase, limit = rateLimit, lookup = lookupBalance } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!(await limit(`balance:${ip}`, 'gift_card'))) {
      return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    }
    try {
      const result = await lookup(getSb(), req.body?.code);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      return res.status(200).json({ ok: true, card: result.card });
    } catch (error) {
      console.error('[gift-cards] balance failed:', error?.message || error);
      return res.status(503).json({ error: 'Balances are unavailable right now. Try again in a moment.' });
    }
  };
}

export default createGiftCardBalanceHandler();
