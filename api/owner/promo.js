import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';
import {
  getPublicPromotion,
  isMissingColumnError,
  isMissingTableError,
  loadMarketingSettings,
  normalizePromoCode,
} from '../_promotions.js';

function dollarsToCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

function sanitizeTitle(value) {
  return String(value || '').trim().slice(0, 60);
}

function sanitizeLabel(value) {
  return String(value || '').trim().slice(0, 90);
}

async function loadPromoPerformance(sb, promoCode) {
  if (!promoCode) {
    return {
      available: true,
      redemptions: 0,
      totalDiscountCents: 0,
      totalRevenueCents: 0,
      recentBookings: [],
    };
  }

  try {
    const { data, error } = await sb
      .from('bookings')
      .select('id, ref, customer_name, total_price, promo_discount_cents, created_at')
      .eq('promo_code', promoCode)
      .gt('promo_discount_cents', 0)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    return {
      available: true,
      redemptions: rows.length,
      totalDiscountCents: rows.reduce((sum, row) => sum + Math.max(0, Number(row.promo_discount_cents || 0)), 0),
      totalRevenueCents: rows.reduce((sum, row) => sum + Math.max(0, Number(row.total_price || 0)), 0),
      recentBookings: rows.slice(0, 10).map((row) => ({
        id: row.id,
        ref: row.ref,
        customerName: row.customer_name || 'Customer',
        totalPrice: Number(row.total_price || 0),
        promoDiscountCents: Number(row.promo_discount_cents || 0),
        createdAt: row.created_at,
      })),
    };
  } catch (error) {
    if (isMissingColumnError(error) || isMissingTableError(error)) {
      return {
        available: false,
        redemptions: 0,
        totalDiscountCents: 0,
        totalRevenueCents: 0,
        recentBookings: [],
      };
    }
    throw error;
  }
}

async function respondWithPromoState(sb, res) {
  const settings = await loadMarketingSettings(sb);
  const promo = getPublicPromotion(settings);
  const performance = await loadPromoPerformance(sb, promo?.code || settings.promoCode || '');
  return res.status(200).json({
    settings: {
      promoEnabled: settings.promoEnabled === true,
      promoCode: settings.promoCode || '',
      promoTitle: settings.promoTitle || '',
      promoLabel: settings.promoLabel || '',
      promoDiscountCents: Math.max(0, Number(settings.promoDiscountCents || 0)),
      promoDiscountDollars: Math.max(0, Number(settings.promoDiscountCents || 0)) / 100,
      firstBookingOnly: settings.firstBookingOnly !== false,
      setupNeeded: settings.setupNeeded === true,
      source: settings.source || 'database',
    },
    publicPromo: promo
      ? {
          ...promo,
          enabled: true,
        }
      : null,
    performance,
  });
}

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  const sb = getSupabase();
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    try {
      return await respondWithPromoState(sb, res);
    } catch (error) {
      console.error('Owner promo GET error:', error);
      return res.status(500).json({ error: 'Failed to load promo settings' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const promoEnabled = req.body?.promoEnabled === true;
  const promoCode = normalizePromoCode(req.body?.promoCode);
  const promoTitle = sanitizeTitle(req.body?.promoTitle);
  const promoLabel = sanitizeLabel(req.body?.promoLabel);
  const promoDiscountCents = dollarsToCents(
    req.body?.promoDiscountDollars != null
      ? req.body?.promoDiscountDollars
      : req.body?.promoDiscountCents / 100,
  );
  const firstBookingOnly = req.body?.firstBookingOnly !== false;

  if (promoEnabled) {
    if (!promoCode || !/^[A-Z0-9-]{4,24}$/.test(promoCode)) {
      return res.status(400).json({ error: 'Promo code must be 4-24 characters using letters, numbers, or dashes.' });
    }
    if (!promoTitle) return res.status(400).json({ error: 'Promo title is required when the offer is active.' });
    if (!promoLabel) return res.status(400).json({ error: 'Promo label is required when the offer is active.' });
    if (promoDiscountCents <= 0) return res.status(400).json({ error: 'Promo discount must be greater than $0.' });
  }

  try {
    const { error } = await sb
      .from('site_marketing_settings')
      .upsert({
        id: 1,
        promo_enabled: promoEnabled,
        promo_code: promoCode || null,
        promo_title: promoTitle || null,
        promo_label: promoLabel || null,
        promo_discount_cents: promoDiscountCents,
        first_booking_only: firstBookingOnly,
        updated_at: new Date().toISOString(),
      });

    if (error) throw error;
    return await respondWithPromoState(sb, res);
  } catch (error) {
    if (isMissingTableError(error)) {
      return res.status(409).json({
        error: 'Promo controls need migration 023 before the owner dashboard can save live offers.',
        setupNeeded: true,
      });
    }
    console.error('Owner promo save error:', error);
    return res.status(500).json({ error: 'Failed to save promo settings' });
  }
}
