import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { calculateBookingPricing } from '../_pricing.js';
import {
  applyPromotionToPricing,
  buildPromotionPreviewPayload,
  resolveBookingPromotion,
} from '../_promotions.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'default')) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  const { services, items, zip, email, promoCode, isQuoteRequest } = req.body || {};
  const serviceList = Array.isArray(services) ? services : [];
  const pricing = calculateBookingPricing({ services: serviceList, itemsByService: items, zip });

  if (pricing.invalidItems.length) {
    return res.status(400).json({
      error: 'Some selected services are no longer available. Please refresh and try again.',
      invalidItems: pricing.invalidItems,
    });
  }

  const sb = getSupabase();
  const promo = await resolveBookingPromotion({
    promoCode,
    email,
    pricing,
    isQuoteRequest: isQuoteRequest === true,
    sb,
  });
  const pricingWithPromo = applyPromotionToPricing(pricing, promo);

  return res.status(200).json({
    success: true,
    ...buildPromotionPreviewPayload(pricingWithPromo, promo),
  });
}
