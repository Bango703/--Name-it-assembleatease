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
import { getMinimumPretaxBookingCents, CANCELLATION_POLICY } from '../_source-of-truth.js';
import { GIFT_CARD_REDEMPTION_READY, previewGiftCard } from '../_gift-cards.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (!await rateLimit(ip, 'default')) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  const { services, items, zip, email, promoCode, isQuoteRequest, date, assemblecashToken, giftCardCode } = req.body || {};
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

  // Gift card: the same cap api/booking.js applies, nothing taken.
  const totalBeforeGiftCents = assemblecash ? assemblecash.totals.totalCents : pricingWithPromo.totalCents;
  const taxBeforeGiftCents = assemblecash ? assemblecash.totals.taxCents : pricingWithPromo.taxCents;
  let giftCard = null;
  let giftCardError = null;
  if (String(giftCardCode || '').trim()) {
    if (!GIFT_CARD_REDEMPTION_READY) {
      giftCardError = { code: 'GIFT_CARD_NOT_AVAILABLE', error: 'Gift cards cannot be used yet.' };
    } else if (isQuoteRequest === true || pricingWithPromo.hasCustomQuote || !(totalBeforeGiftCents > 0)) {
      giftCardError = { code: 'GIFT_CARD_QUOTE', error: 'A gift card can be used on a priced booking.' };
    } else {
      try {
        const preview = await previewGiftCard(sb, {
          code: giftCardCode,
          totalCents: totalBeforeGiftCents,
          serviceSubtotalCents: totalBeforeGiftCents - taxBeforeGiftCents - pricingWithPromo.serviceCallFeeCents,
          maxCancellationFeePct: Math.max(CANCELLATION_POLICY.lateFeePct, CANCELLATION_POLICY.imminentFeePct),
        });
        if (preview.ok) giftCard = preview;
        else giftCardError = { code: preview.code, error: preview.error };
      } catch (error) {
        console.error('Gift card preview failed:', error?.message || error);
        giftCardError = { code: 'GIFT_CARD_UNAVAILABLE', error: 'Gift cards are unavailable right now. Try again in a moment.' };
      }
    }
  }
  const giftCents = giftCard ? giftCard.appliedCents : 0;

  return res.status(200).json({
    success: true,
    ...buildPromotionPreviewPayload(pricingWithPromo, promo),
    summary: checkoutSummary(pricingWithPromo, promo, assemblecash, giftCard),
    assemblecash: assemblecash ? { applied_cents: assemblecash.redeemCents, balance_cents: assemblecash.balanceCents } : null,
    gift_card: giftCard ? {
      applied_cents: giftCard.appliedCents,
      remaining_cents: giftCard.remainingCents,
      last4: giftCard.last4,
      priority: giftCard.priority,
    } : null,
    gift_card_error: giftCardError,
    plan: checkoutPlan({ totalCents: totalBeforeGiftCents - giftCents, hasCustomQuote: pricingWithPromo.hasCustomQuote, date: appointmentDate }),
  });
}
