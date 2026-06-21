import { NEW_CUSTOMER_OFFER } from './_source-of-truth.js';
import { TX_TAX_RATE } from './_pricing.js';

function buildLegacyPromoSettings() {
  return {
    promoEnabled: true,
    promoCode: NEW_CUSTOMER_OFFER.code,
    promoTitle: NEW_CUSTOMER_OFFER.title,
    promoLabel: NEW_CUSTOMER_OFFER.label,
    promoDiscountCents: NEW_CUSTOMER_OFFER.discountCents,
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
    firstBookingOnly: value.firstBookingOnly !== false && value.first_booking_only !== false,
    setupNeeded: value.setupNeeded === true,
    source: String(value.source || 'database'),
  };
}

export function getPublicPromotion(settings) {
  const normalized = normalizePromoSettings(settings);
  if (!normalized.promoEnabled || !normalized.promoCode || normalized.promoDiscountCents <= 0) {
    return null;
  }
  return {
    code: normalized.promoCode,
    title: normalized.promoTitle || 'Special Offer',
    label: normalized.promoLabel || 'Promo discount',
    discountCents: normalized.promoDiscountCents,
    firstBookingOnly: normalized.firstBookingOnly !== false,
  };
}

export async function loadMarketingSettings(sb, { allowFallback = true } = {}) {
  if (!sb) throw new Error('Missing Supabase client for marketing settings');
  const { data, error } = await sb
    .from('site_marketing_settings')
    .select('id, promo_enabled, promo_code, promo_title, promo_label, promo_discount_cents, first_booking_only, updated_at')
    .eq('id', 1)
    .maybeSingle();

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

  const discountCents = Math.min(
    activePromo.discountCents,
    Math.max(0, Number(pricing.discountedItemSubtotalCents || 0)),
  );
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
  const taxableSubtotalCents = promoAdjustedItemSubtotalCents + serviceCallFeeCents;
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
      taxCents: Math.max(0, Number(pricingWithPromo?.taxCents || 0)),
      totalCents: Math.max(0, Number(pricingWithPromo?.totalCents || 0)),
      hasCustomQuote: !!pricingWithPromo?.hasCustomQuote,
      isAddonOnly: !!pricingWithPromo?.isAddonOnly,
    },
  };
}
