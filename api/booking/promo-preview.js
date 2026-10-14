import { getSupabase } from '../_supabase.js';
import { rateLimit } from '../_ratelimit.js';
import { calculateBookingPricing } from '../_pricing.js';
import {
  applyPromotionToPricing,
  buildPromotionPreviewPayload,
  resolveBookingPromotion,
} from '../_promotions.js';
import { sameDayFeeForAppointment } from '../_source-of-truth.js';
import { parseIsoCalendarDate } from './_appt-date.js';
import { checkoutPlan, checkoutSummary } from './_checkout.js';
import { getAvailableBalanceCents, maxRedeemableCents, totalsAfterAssembleCash, verifyRedemptionToken } from '../_assemblecash.js';
import { getMinimumPretaxBookingCents } from '../_source-of-truth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'default')) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  const { services, items, zip, email, promoCode, isQuoteRequest, date, assemblecashToken } = req.body || {};
  const serviceList = Array.isArray(services) ? services : [];
  // A date makes the preview the booking's own price (same-day fee included) and
  // adds how it is paid. Without one it stays the website's promo check.
  const appointmentDate = parseIsoCalendarDate(date) ? String(date) : null;
  const sameDayFeeCents = appointmentDate ? sameDayFeeForAppointment(appointmentDate) : 0;
  const pricing = calculateBookingPricing({ services: serviceList, itemsByService: items, zip, sameDayFeeCents });

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

  // AssembleCash the booking would apply: the same balance, cap and floor as
  // api/booking.js, so the summary shows the total the card is held for. The
  // pricing block above stays before AssembleCash; the booking checks the
  // promo against that figure before it applies the credit.
  let assemblecash = null;
  if (assemblecashToken && isQuoteRequest !== true && pricingWithPromo.totalCents > 0
      && verifyRedemptionToken(assemblecashToken, email)) {
    const balanceCents = await getAvailableBalanceCents(sb, email);
    const redeemCents = maxRedeemableCents({
      balanceCents,
      pretaxBaseCents: pricingWithPromo.promoAdjustedItemSubtotalCents,
      marginFloorCents: getMinimumPretaxBookingCents(pricingWithPromo.callZone) || 0,
    });
    if (redeemCents > 0) {
      assemblecash = {
        redeemCents,
        balanceCents,
        totals: totalsAfterAssembleCash({
          promoAdjustedItemSubtotalCents: pricingWithPromo.promoAdjustedItemSubtotalCents,
          serviceCallFeeCents: pricingWithPromo.serviceCallFeeCents,
          sameDayFeeCents: pricingWithPromo.sameDayFeeCents,
          redeemCents,
        }),
      };
    }
  }

  return res.status(200).json({
    success: true,
    ...buildPromotionPreviewPayload(pricingWithPromo, promo),
    summary: checkoutSummary(pricingWithPromo, promo, assemblecash),
    assemblecash: assemblecash ? { applied_cents: assemblecash.redeemCents, balance_cents: assemblecash.balanceCents } : null,
    plan: checkoutPlan({ totalCents: assemblecash ? assemblecash.totals.totalCents : pricingWithPromo.totalCents, hasCustomQuote: pricingWithPromo.hasCustomQuote, date: appointmentDate }),
  });
}
