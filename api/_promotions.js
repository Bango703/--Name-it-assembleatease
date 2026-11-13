import { NEW_CUSTOMER_OFFER } from './_source-of-truth.js';
import { TX_TAX_RATE } from './_pricing.js';
import { isReviewRewardCode, REVIEW_REWARD_DISCOUNT_CENTS, REVIEW_REWARD_MINIMUM_CENTS } from './_review-rewards.js';
import { ACCOUNT_CODE, ACCOUNT_MAX_DISCOUNT_PCT, commercialAccountsEnabled } from './_partners.js';

function buildLegacyPromoSettings() {
  return {
    promoEnabled: true,
    promoCode: NEW_CUSTOMER_OFFER.code,
    promoTitle: NEW_CUSTOMER_OFFER.title,
    promoLabel: NEW_CUSTOMER_OFFER.label,
    promoDiscountCents: NEW_CUSTOMER_OFFER.discountCents,
    promoDiscountType: 'amount',
    promoDiscountPct: 0,
    firstBookingOnly: true,
    setupNeeded: true,
    source: 'legacy_fallback',
  };
}

function buildEmptyPromoSettings() {
  return {
    promoEnabled: false,
    promoCode: '',
    promoTitle: '',
    promoLabel: '',
    promoDiscountCents: 0,
    promoDiscountType: 'amount',
    promoDiscountPct: 0,
    firstBookingOnly: true,
    setupNeeded: false,
    source: 'database',
  };
}

export function normalizePromoCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function isValidPromoEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

export function isMissingTableError(error) {
  const msg = String(error?.message || '');
  return error?.code === '42P01' || /relation .* does not exist/i.test(msg);
}

export function isMissingColumnError(error) {
  const msg = String(error?.message || '');
  return error?.code === '42703' || /column .* does not exist/i.test(msg);
}

export function normalizePromoSettings(value) {
  if (!value || typeof value !== 'object') return buildEmptyPromoSettings();
  return {
    promoEnabled: value.promoEnabled === true || value.promo_enabled === true,
    promoCode: normalizePromoCode(value.promoCode ?? value.promo_code),
    promoTitle: String(value.promoTitle ?? value.promo_title ?? '').trim(),
    promoLabel: String(value.promoLabel ?? value.promo_label ?? '').trim(),
    promoDiscountCents: Math.max(
      0,
      Math.round(Number(value.promoDiscountCents ?? value.promo_discount_cents ?? 0) || 0),
    ),
    promoDiscountType: String(value.promoDiscountType ?? value.promo_discount_type ?? 'amount') === 'percent' ? 'percent' : 'amount',
    promoDiscountPct: Math.max(0, Math.min(100, Math.round(Number(value.promoDiscountPct ?? value.promo_discount_pct ?? 0) || 0))),
    firstBookingOnly: value.firstBookingOnly !== false && value.first_booking_only !== false,
    setupNeeded: value.setupNeeded === true,
    source: String(value.source || 'database'),
  };
}

export function getPublicPromotion(settings) {
  const normalized = normalizePromoSettings(settings);
  const isPercent = normalized.promoDiscountType === 'percent';
  const hasDiscount = isPercent ? normalized.promoDiscountPct > 0 : normalized.promoDiscountCents > 0;
  if (!normalized.promoEnabled || !normalized.promoCode || !hasDiscount) {
    return null;
  }
  return {
    code: normalized.promoCode,
    title: normalized.promoTitle || 'Special Offer',
    label: normalized.promoLabel || 'Promo discount',
    discountType: normalized.promoDiscountType,
    discountCents: normalized.promoDiscountCents,
    discountPct: normalized.promoDiscountPct,
    firstBookingOnly: normalized.firstBookingOnly !== false,
  };
}

export async function loadMarketingSettings(sb, { allowFallback = true } = {}) {
  if (!sb) throw new Error('Missing Supabase client for marketing settings');
  let { data, error } = await sb
    .from('site_marketing_settings')
    .select('id, promo_enabled, promo_code, promo_title, promo_label, promo_discount_cents, promo_discount_type, promo_discount_pct, first_booking_only, updated_at')
    .eq('id', 1)
    .maybeSingle();

  // Graceful before migration 024 (type/pct columns absent): fall back to base columns.
  if (error && isMissingColumnError(error)) {
    ({ data, error } = await sb
      .from('site_marketing_settings')
      .select('id, promo_enabled, promo_code, promo_title, promo_label, promo_discount_cents, first_booking_only, updated_at')
      .eq('id', 1)
      .maybeSingle());
  }

  if (error) {
    if (allowFallback && isMissingTableError(error)) return buildLegacyPromoSettings();
    throw error;
  }

  if (!data) return buildEmptyPromoSettings();
  return normalizePromoSettings(data);
}

export async function resolveBookingPromotion({
  promoCode,
  email,
  pricing,
  isQuoteRequest = false,
  sb,
  promoSettings,
}) {
  const enteredCode = normalizePromoCode(promoCode);
  const settings = promoSettings
    ? normalizePromoSettings(promoSettings)
    : await loadMarketingSettings(sb);
  const activePromo = getPublicPromotion(settings);
  const base = {
    enteredCode,
    applied: false,
    appliedCode: '',
    discountCents: 0,
    label: activePromo?.label || settings.promoLabel || 'Promo discount',
    title: activePromo?.title || settings.promoTitle || 'Special Offer',
    reason: enteredCode ? 'not_applied' : 'no_code',
  };

  if (!enteredCode) return base;
  if (isReviewRewardCode(enteredCode)) {
    const rewardBase = { ...base, title: 'Review thank-you offer', label: '$10 off your next booking' };
    if (isQuoteRequest) return { ...rewardBase, reason: 'quote_request_not_eligible' };
    if (!pricing?.hasPricedBaseItem || pricing?.discountedItemSubtotalCents < REVIEW_REWARD_MINIMUM_CENTS) {
      return { ...rewardBase, reason: 'minimum_not_met' };
    }
    if (!isValidPromoEmail(email)) return { ...rewardBase, reason: 'email_required' };
    if (!sb) throw new Error('Missing Supabase client for review reward validation');
    const { data: reward, error } = await sb.from('review_reward_codes')
      .select('id, customer_email, status, expires_at, reserved_until')
      .eq('code', enteredCode)
      .maybeSingle();
    if (error) throw error;
    const available = reward && reward.customer_email === String(email || '').trim().toLowerCase()
      && new Date(reward.expires_at).getTime() > Date.now()
      && (reward.status === 'issued' || (reward.status === 'reserved' && new Date(reward.reserved_until).getTime() < Date.now()));
    if (!available) return { ...rewardBase, reason: 'invalid_or_used_code' };
    const discountCents = Math.min(REVIEW_REWARD_DISCOUNT_CENTS, Number(pricing.discountedItemSubtotalCents || 0));
    return { ...rewardBase, applied: true, appliedCode: enteredCode, discountCents, reason: 'applied', reviewRewardId: reward.id };
  }
  // A partner account's code (api/_partners.js, migration 129): the account's
  // discount on the catalog items, and the booking is tagged with the account
  // so dispatch offers it to the account's preferred Easers first.
  if (ACCOUNT_CODE.test(enteredCode) && commercialAccountsEnabled()) {
    const accountBase = { ...base, title: 'Account pricing', label: 'Account pricing' };
    if (isQuoteRequest) return { ...accountBase, reason: 'quote_request_not_eligible' };
    if (!sb) throw new Error('Missing Supabase client for account pricing');
    const { data: account, error } = await sb.from('partner_leads')
      .select('id, name, account_status, account_discount_pct, account_preferred_easer_ids')
      .eq('account_code', enteredCode)
      .maybeSingle();
    if (error) {
      if (isMissingTableError(error) || isMissingColumnError(error) || /account_/i.test(String(error.message || ''))) return { ...accountBase, reason: 'invalid_code' };
      throw error;
    }
    if (!account || account.account_status !== 'active') return { ...accountBase, reason: 'invalid_code' };
    if (!pricing?.hasPricedBaseItem || pricing?.discountedItemSubtotalCents <= 0) return { ...accountBase, reason: 'no_eligible_items' };
    const pct = Math.max(0, Math.min(ACCOUNT_MAX_DISCOUNT_PCT, Number(account.account_discount_pct) || 0));
    const eligible = Math.max(0, Number(pricing.discountedItemSubtotalCents || 0));
    const discountCents = Math.min(Math.round(eligible * pct / 100), eligible);
    return {
      ...accountBase,
      title: `${account.name} account pricing`,
      label: pct > 0 ? `${account.name}: ${pct}% off` : `${account.name} account`,
      applied: true,
      appliedCode: enteredCode,
      discountCents,
      reason: 'applied',
      commercialAccountId: account.id,
      preferredEaserIds: Array.isArray(account.account_preferred_easer_ids) ? account.account_preferred_easer_ids : [],
    };
  }
  if (!activePromo || enteredCode !== activePromo.code) return { ...base, reason: 'invalid_code' };
  if (isQuoteRequest) return { ...base, reason: 'quote_request_not_eligible' };
  if (!pricing?.hasPricedBaseItem || pricing?.discountedItemSubtotalCents <= 0) {
    return { ...base, reason: 'no_eligible_items' };
  }
  if (!isValidPromoEmail(email)) return { ...base, reason: 'email_required' };
  if (!sb) throw new Error('Missing Supabase client for promotion validation');

  if (settings.firstBookingOnly !== false) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const { count, error } = await sb
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .ilike('customer_email', normalizedEmail);

    if (error) throw error;
    if ((count || 0) > 0) return { ...base, reason: 'not_first_booking' };
  }

  const eligibleSubtotalCents = Math.max(0, Number(pricing.discountedItemSubtotalCents || 0));
  const rawDiscountCents = activePromo.discountType === 'percent'
    ? Math.round(eligibleSubtotalCents * (Number(activePromo.discountPct) || 0) / 100)
    : (Number(activePromo.discountCents) || 0);
  const discountCents = Math.min(Math.max(0, rawDiscountCents), eligibleSubtotalCents);
  if (discountCents <= 0) return { ...base, reason: 'no_discount_available' };

  return {
    ...base,
    applied: true,
    appliedCode: activePromo.code,
    discountCents,
    reason: 'applied',
  };
}

export function applyPromotionToPricing(pricing, promo) {
  const promoDiscountCents = promo?.applied
    ? Math.min(
        Math.max(0, Number(promo.discountCents || 0)),
        Math.max(0, Number(pricing?.discountedItemSubtotalCents || 0)),
      )
    : 0;
  const promoAdjustedItemSubtotalCents = Math.max(
    0,
    Math.max(0, Number(pricing?.discountedItemSubtotalCents || 0)) - promoDiscountCents,
  );
  const serviceCallFeeCents = Math.max(0, Number(pricing?.serviceCallFeeCents || 0));
  // Same-day fee is additive and not discountable — carry it through the promo
  // recompute exactly like the service-call fee, or it would vanish after a promo.
  const sameDayFeeCents = Math.max(0, Number(pricing?.sameDayFeeCents || 0));
  const taxableSubtotalCents = promoAdjustedItemSubtotalCents + serviceCallFeeCents + sameDayFeeCents;
  const taxCents = Math.round(taxableSubtotalCents * TX_TAX_RATE);
  const totalCents = taxableSubtotalCents + taxCents;

  return {
    ...pricing,
    promoEnteredCode: promo?.enteredCode || '',
    promoCode: promo?.appliedCode || '',
    promoApplied: !!promo?.applied,
    promoReason: promo?.reason || 'no_code',
    promoDiscountCents,
    promoAdjustedItemSubtotalCents,
    taxableSubtotalCents,
    taxCents,
    totalCents,
  };
}

export function buildPromotionPreviewPayload(pricingWithPromo, promo) {
  return {
    promo: {
      enteredCode: promo?.enteredCode || '',
      applied: !!promo?.applied,
      appliedCode: promo?.appliedCode || '',
      discountCents: Math.max(0, Number(pricingWithPromo?.promoDiscountCents || 0)),
      label: promo?.label || 'Promo discount',
      title: promo?.title || 'Special Offer',
      reason: promo?.reason || 'no_code',
    },
    pricing: {
      itemSubtotalCents: Math.max(0, Number(pricingWithPromo?.itemSubtotalCents || 0)),
      bundleDiscountCents: Math.max(0, Number(pricingWithPromo?.discountCents || 0)),
      serviceCallFeeCents: Math.max(0, Number(pricingWithPromo?.serviceCallFeeCents || 0)),
      sameDayFeeCents: Math.max(0, Number(pricingWithPromo?.sameDayFeeCents || 0)),
      taxCents: Math.max(0, Number(pricingWithPromo?.taxCents || 0)),
      totalCents: Math.max(0, Number(pricingWithPromo?.totalCents || 0)),
      hasCustomQuote: !!pricingWithPromo?.hasCustomQuote,
      isAddonOnly: !!pricingWithPromo?.isAddonOnly,
    },
  };
}
